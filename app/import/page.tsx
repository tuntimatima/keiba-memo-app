'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
);

// ダブルクォート対応の簡易CSVパーサ（行単位）
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ',') {
      row.push(cell);
      cell = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      continue;
    }
    cell += ch;
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function toIsoDate(dateS: string): string | null {
  // "2026.2.1" -> "2026-02-01"
  const s = (dateS ?? '').trim();
  if (!s) return null;
  const parts = s.split('.');
  if (parts.length !== 3) return null;
  const y = parts[0].padStart(4, '0');
  const m = parts[1].padStart(2, '0');
  const d = parts[2].padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toInt(v: string): number | null {
  const s = (v ?? '').toString().replace(/[^\d]/g, '');
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

export default function ImportPage() {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const preview = useMemo(() => rows.slice(0, 5), [rows]);

  async function onPickFile(file: File | null) {
    setStatus('');
    setRows([]);
    if (!file) {
      setFileName('');
      return;
    }
    setFileName(file.name);

    // Shift-JIS優先で読む
    const buf = await file.arrayBuffer();
    let text = '';
    try {
      text = new TextDecoder('shift-jis').decode(buf);
    } catch {
      text = new TextDecoder('utf-8').decode(buf);
    }

    const table = parseCsv(text);
    if (table.length < 2) {
      setStatus('NG: CSVが空です');
      return;
    }

    const header = table[0].map((s) => (s ?? '').trim());
    const data = table.slice(1).filter((r) => r.some((c) => (c ?? '').trim() !== ''));

    // 必須ヘッダ検査（不足なら停止）
    const requiredHeaders = [
      'レースID(新)',
      '日付S',
      '場所',
      'Ｒ',
      'レース名',
      '芝ダ',
      '距離',
      'コース区分',
      '枠番',
      '馬番',
      '血統登録番号',
      '馬名',
      '馬印8',
      'レースコメント',
      '結果コメント',
    ];
    const missing = requiredHeaders.filter((k) => !header.includes(k));
    if (missing.length) {
      setStatus(`NG: CSVヘッダ不足: ${missing.join(', ')}`);
      setRows([]);
      return;
    }

    const mapped: Record<string, string>[] = data.map((r) => {
      const obj: Record<string, string> = {};
      for (let i = 0; i < header.length; i++) obj[header[i]] = (r[i] ?? '').trim();
      return obj;
    });

    setRows(mapped);
    setStatus(`OK: 読み込み ${mapped.length} 行`);
  }

  async function doImport() {
    setStatus('');
    setBusy(true);

    try {
      const { data: sess, error: sErr } = await supabase.auth.getSession();
      if (sErr) throw sErr;
      const uid = sess.session?.user?.id;
      if (!uid) {
        setStatus('NG: ログインしてください');
        return;
      }

      // 必須値チェック（race_id / horse_id）…1行でも欠損があれば停止
      const bad: { idx: number; reason: string; race_id: string; horse_id: string; horse_name: string }[] = [];
      rows.forEach((h, i) => {
        const race_id = (h['レースID(新)'] ?? '').trim();
        const horse_id = (h['血統登録番号'] ?? '').trim();
        const horse_name = (h['馬名'] ?? '').trim();
        if (!race_id) bad.push({ idx: i + 2, reason: 'レースID(新)が空', race_id, horse_id, horse_name });
        else if (!horse_id) bad.push({ idx: i + 2, reason: '血統登録番号が空', race_id, horse_id, horse_name });
      });

      if (bad.length) {
        const sample = bad
          .slice(0, 5)
          .map(
            (e) =>
              `L${e.idx}:${e.reason}（race_id=${e.race_id || '-'} horse_id=${e.horse_id || '-'} 馬名=${e.horse_name || '-'}）`
          )
          .join(' / ');
        setStatus(`NG: 必須項目欠損 ${bad.length}行。${sample}`);
        return;
      }

      // races/horses/entries 用に重複排除
      const raceMap = new Map<string, any>();
      const horseMap = new Map<string, any>();
      const entryMap = new Map<string, any>();

      // memos（全行）
      const memosPayload = rows.map((h) => {
        const race_id = (h['レースID(新)'] ?? '').trim();
        const race_date = toIsoDate(h['日付S'] ?? '');
        const place = (h['場所'] ?? '').trim();
        const race_no = toInt(h['Ｒ'] ?? '');
        const race_name = (h['レース名'] ?? '').trim();
        const surface = (h['芝ダ'] ?? '').trim();
        const distance_m = toInt(h['距離'] ?? '');
        const course_kbn = (h['コース区分'] ?? '').trim();

        const horse_id = (h['血統登録番号'] ?? '').trim();
        const horse_name = (h['馬名'] ?? '').trim();

        const waku = toInt(h['枠番'] ?? '');
        const umaban = toInt(h['馬番'] ?? '');

        const uma_mark8 = (h['馬印8'] ?? '').trim();
        const race_comment = (h['レースコメント'] ?? '').trim();
        const result_comment = (h['結果コメント'] ?? '').trim();

        if (race_id && !raceMap.has(race_id)) {
          raceMap.set(race_id, {
            race_id,
            race_date: race_date,
            place: place || null,
            race_no: race_no,
            race_name: race_name || null,
            surface: surface || null,
            distance_m: distance_m,
            course_kbn: course_kbn || null,
          });
        }

        if (horse_id && !horseMap.has(horse_id)) {
          horseMap.set(horse_id, {
            horse_id,
            horse_name: horse_name || '(不明)',
          });
        }

        if (race_id && horse_id) {
          const key = `${race_id}__${horse_id}`;
          if (!entryMap.has(key)) {
            entryMap.set(key, { race_id, horse_id, waku, umaban });
          }
        }

        return {
          user_id: uid,
          author_name: sess.session?.user?.email ?? null,
          updated_by: uid,
          updated_by_name: sess.session?.user?.email ?? null,

          race_id: race_id || null,
          horse_id: horse_id || null,
          horse_name: horse_name || null,
          uma_mark8: uma_mark8 || null,
          race_comment: race_comment || null,
          result_comment: result_comment || null,
        };
      });

      const racesPayload = Array.from(raceMap.values());
      const horsesPayload = Array.from(horseMap.values());
      const entriesPayload = Array.from(entryMap.values());

      const batchSize = 200;

      // races → horses → entries → memos の順で投入（外部キー対策）
      let done = 0;
      for (let i = 0; i < racesPayload.length; i += batchSize) {
        const chunk = racesPayload.slice(i, i + batchSize);
        const { error } = await supabase.from('races').upsert(chunk, { onConflict: 'race_id' });
        if (error) {
          setStatus(`NG: races upsert: ${error.message}（${i + 1}行目あたり）`);
          return;
        }
        done += chunk.length;
        setStatus(`進行中: races ${done}/${racesPayload.length}`);
      }

      done = 0;
      for (let i = 0; i < horsesPayload.length; i += batchSize) {
        const chunk = horsesPayload.slice(i, i + batchSize);
        const { error } = await supabase.from('horses').upsert(chunk, { onConflict: 'horse_id' });
        if (error) {
          setStatus(`NG: horses upsert: ${error.message}（${i + 1}行目あたり）`);
          return;
        }
        done += chunk.length;
        setStatus(`進行中: horses ${done}/${horsesPayload.length}`);
      }

      done = 0;
      for (let i = 0; i < entriesPayload.length; i += batchSize) {
        const chunk = entriesPayload.slice(i, i + batchSize);
        const { error } = await supabase.from('entries').upsert(chunk, { onConflict: 'race_id,horse_id' });
        if (error) {
          setStatus(`NG: entries upsert: ${error.message}（${i + 1}行目あたり）`);
          return;
        }
        done += chunk.length;
        setStatus(`進行中: entries ${done}/${entriesPayload.length}`);
      }

      done = 0;
      for (let i = 0; i < memosPayload.length; i += batchSize) {
        const chunk = memosPayload.slice(i, i + batchSize);
        const { error } = await supabase.from('memos').upsert(chunk, {
          onConflict: 'race_id,horse_id,user_id',
          ignoreDuplicates: false, // 上書き
        });
        if (error) {
          setStatus(`NG: memos upsert: ${error.message}（${i + 1}行目あたり）`);
          return;
        }
        done += chunk.length;
        setStatus(`進行中: memos ${done}/${memosPayload.length}`);
      }

      setStatus(
        `OK: 取り込み完了（races:${racesPayload.length}, horses:${horsesPayload.length}, entries:${entriesPayload.length}, memos:${memosPayload.length}）`
      );
    } catch (e: any) {
      setStatus(`NG: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={{ padding: 24, fontFamily: 'sans-serif', maxWidth: 860 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>CSV取り込み</h1>
        <Link
          href="/"
          style={{
            padding: '8px 12px',
            border: '1px solid #555',
            borderRadius: 6,
            textDecoration: 'none',
            color: '#111',
          }}
        >
          ← 戻る
        </Link>
      </div>

      {/* ★追加：注意文（タイトルとファイル選択の間） */}
      <div style={{ marginTop: 12, padding: 12, border: '1px solid #bbb', borderRadius: 8, background: '#fff' }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>※取込ファイル注意</div>
        <div style={{ fontSize: 13, lineHeight: 1.6 }}>
          ①A列のヘッダ名は「レースID(新)」<br />
          ②レースIDは馬番無しのものを使用(馬番を示す末尾の2桁が不要)<br />
          ③F列のヘッダ名は「芝ダ」(出走馬分析から出すと芝・ダになる)
        </div>
      </div>

      <section style={{ marginTop: 16, border: '1px solid #444', padding: 12, borderRadius: 8 }}>
        <div style={{ fontWeight: 700 }}>CSVファイル</div>

        <input
          id="csvFileInput"
          type="file"
          accept=".csv,text/csv"
          onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
          disabled={busy}
          style={{ display: 'none' }}
        />

        <label
          htmlFor="csvFileInput"
          style={{
            display: 'inline-block',
            marginTop: 8,
            padding: '8px 12px',
            border: '1px solid #555',
            borderRadius: 6,
            cursor: busy ? 'not-allowed' : 'pointer',
            opacity: busy ? 0.6 : 1,
            background: '#fff',
            userSelect: 'none',
          }}
        >
          ファイルを選択
        </label>
          

        <div style={{ marginTop: 8, opacity: 0.8 }}>選択中: {fileName ? fileName : '(未選択)'}</div>

        <button
          onClick={doImport}
          disabled={busy || rows.length === 0}
          style={{
            marginTop: 12,
            padding: '8px 12px',
            border: '1px solid #555',
            borderRadius: 6,
            opacity: busy || rows.length === 0 ? 0.6 : 1,
            cursor: busy || rows.length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          {busy ? '取り込み中...' : '取り込み実行'}
        </button>

        {status && <div style={{ marginTop: 12 }}>{status}</div>}
      </section>

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>プレビュー（先頭5行）</h2>
        <div style={{ marginTop: 8, opacity: 0.85 }}>読み込み行数: {rows.length}</div>

        <div style={{ marginTop: 8, border: '1px solid #333', borderRadius: 8, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {Object.keys(preview[0] ?? {})
                  .slice(0, 8)
                  .map((k) => (
                    <th
                      key={k}
                      style={{ textAlign: 'left', padding: 8, borderBottom: '1px solid #333', fontSize: 12 }}
                    >
                      {k}
                    </th>
                  ))}
              </tr>
            </thead>
            <tbody>
              {preview.map((r, idx) => (
                <tr key={idx}>
                  {Object.keys(preview[0] ?? {})
                    .slice(0, 8)
                    .map((k) => (
                      <td
                        key={k}
                        style={{ padding: 8, borderBottom: '1px solid #222', fontSize: 12, opacity: 0.9 }}
                      >
                        {r[k]}
                      </td>
                    ))}
                </tr>
              ))}
              {rows.length === 0 && (
                <tr>
                  <td style={{ padding: 12, opacity: 0.7 }}>CSVを選択してください</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}