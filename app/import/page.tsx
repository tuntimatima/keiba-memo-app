'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../lib/supabaseClient';

type CsvRow = Record<string, string>;

const REQUIRED_HEADERS = [
  'レースID(新)',
  '日付S',
  '場所',
  'Ｒ',
  'レース名',
  '芝ダ',
  '距離',
  '枠番',
  '馬番',
  '馬名',
  '血統登録番号',
  '馬印8',
  'レースコメント',
  '結果コメント',
] as const;

function parseCsv(text: string): string[][] {
  // RFC4180-ish parser (handles quotes, commas, CRLF)
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (ch === '\n') {
      if (field.endsWith('\r')) field = field.slice(0, -1);
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }

    field += ch;
  }

  if (field.length || row.length) {
    if (field.endsWith('\r')) field = field.slice(0, -1);
    row.push(field);
    rows.push(row);
  }

  while (rows.length && rows[rows.length - 1].every((c) => (c ?? '').trim() === '')) rows.pop();
  return rows;
}

function toInt(s: string): number | null {
  const t = (s ?? '').toString().trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeDate(s: string): string | null {
  const t = (s ?? '').toString().trim();
  if (!t) return null;
  // accept YYYY-MM-DD or YYYY/MM/DD or YYYY.M.D
  const m = t.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/);
  if (!m) return null;
  const yyyy = m[1];
  const mm = m[2].padStart(2, '0');
  const dd = m[3].padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export default function ImportPage() {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const [fileName, setFileName] = useState<string>('未選択');
  const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
  const [headers, setHeaders] = useState<string[]>([]);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      setUserEmail(data.session?.user?.email ?? null);
      setUserId(data.session?.user?.id ?? null);
    })();
  }, []);

  const preview = useMemo(() => csvRows.slice(0, 5), [csvRows]);

  async function readFileAsText(file: File): Promise<string> {
    const buf = await file.arrayBuffer();
    // Chrome/Edge supports 'shift-jis'. If unavailable, fallback to utf-8.
    try {
      return new TextDecoder('shift-jis').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }

  async function onPickFile(f: File | null) {
    setStatus('');
    setCsvRows([]);
    setHeaders([]);
    if (!f) {
      setFileName('未選択');
      return;
    }
    setFileName(f.name);

    const text = await readFileAsText(f);
    const table = parseCsv(text);

    if (table.length < 2) {
      setStatus('NG: CSVの行数が足りません（ヘッダ＋1行以上必要）');
      return;
    }

    const hdr = table[0].map((s) => (s ?? '').toString().trim());
    setHeaders(hdr);

    const missing = REQUIRED_HEADERS.filter((h) => !hdr.includes(h));
    if (missing.length) {
      setStatus(`NG: 必須ヘッダが不足しています: ${missing.join(', ')}`);
      return;
    }

    const data = table
      .slice(1)
      .filter((r) => r.some((c) => (c ?? '').toString().trim() !== ''));

    const rows: CsvRow[] = data.map((r) => {
      const obj: CsvRow = {};
      hdr.forEach((h, idx) => {
        obj[h] = (r[idx] ?? '').toString();
      });
      return obj;
    });

    setCsvRows(rows);
    setStatus(`OK: 読み込み行数: ${rows.length}`);
  }

  async function runImport() {
    if (busy) return;
    if (!csvRows.length) {
      setStatus('NG: CSVを選択してください');
      return;
    }

    // 必ず最新のセッションを取得する（キャッシュされたクライアントが認証を持たない場合に備える）
    const { data: sessionData } = await supabase.auth.getSession();
    const session = sessionData?.session;
    if (!session?.user?.id) {
      setStatus('NG: ログイン情報を取得できませんでした。ログインし直してください。');
      return;
    }

    const currentUserId = session.user.id;
    const currentUserEmail = session.user.email ?? null;

    // 認証済みのアクセストークンをセットし直す（RLS対策）
    await supabase.auth.setSession({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
    });

    setBusy(true);
    setStatus('1/5 データ解析中...');

    const racesMap = new Map<string, any>();
    const horsesMap = new Map<string, any>();
    const entriesMap = new Map<string, any>();
    const memosInCsv: any[] = [];


    for (const r of csvRows) {
      const raceIdRaw = (r['レースID(新)'] ?? '').trim();

      if (raceIdRaw.length !== 18 && raceIdRaw.length !== 20) {
        setStatus(`NG: レースID(新)の長さが不正です: "${raceIdRaw}" (${raceIdRaw.length}文字)`);
        setBusy(false);
        return;
      }
      const raceId = raceIdRaw.length === 20 ? raceIdRaw.slice(0, 18) : raceIdRaw;

      const raceDate = normalizeDate(r['日付S']);
      const place = (r['場所'] ?? '').trim() || null;
      const raceNo = toInt(r['Ｒ']);
      const raceName = (r['レース名'] ?? '').trim() || null;
      const surface = (r['芝ダ'] ?? '').trim() || null;
      const distanceM = toInt(r['距離']);
      const waku = toInt(r['枠番']);
      const umaban = toInt(r['馬番']);
      const horseName = (r['馬名'] ?? '').trim() || null;
      const horseId = (r['血統登録番号'] ?? '').trim();

      if (!raceId || !horseId) continue;

      if (!racesMap.has(raceId)) {
        racesMap.set(raceId, {
          race_id: raceId,
          race_date: raceDate,
          place,
          race_no: raceNo,
          race_name: raceName,
          surface,
          distance_m: distanceM,
        });
      }

      if (!horsesMap.has(horseId)) {
        horsesMap.set(horseId, {
          horse_id: horseId,
          horse_name: horseName,
        });
      }

      const ek = `${raceId}__${horseId}`;
      if (!entriesMap.has(ek)) {
        entriesMap.set(ek, {
          race_id: raceId,
          horse_id: horseId,
          waku,
          umaban,
        });
      }

      const mark8 = (r['馬印8'] ?? '').trim() || null;
      const raceComment = (r['レースコメント'] ?? '').trim() || null;
      const resultComment = (r['結果コメント'] ?? '').trim() || null;

      memosInCsv.push({
        race_id: raceId,
        horse_id: horseId,
        user_id: currentUserId,
        author_name: currentUserEmail,
        uma_mark8: mark8,
        race_comment: raceComment,
        result_comment: resultComment,
      });
    }

    const races = Array.from(racesMap.values());
    const horses = Array.from(horsesMap.values());
    const entries = Array.from(entriesMap.values());

    try {
      // Reactに画面更新の機会を与えるためのyield関数
      const tick = () => new Promise<void>(r => setTimeout(r, 0));

      const chunkArray = <T,>(arr: T[], size: number): T[][] => {
        const res: T[][] = [];
        for (let i = 0; i < arr.length; i += size) res.push(arr.slice(i, i + size));
        return res;
      };

      if (races.length) {
        setStatus(`2/5 レース情報更新中 (${races.length}件)...`);
        await tick();
        for (const chunk of chunkArray(races, 1000)) {
          const { error } = await (supabase.from('races') as any).upsert(chunk, { onConflict: 'race_id' });
          if (error) throw new Error(`races upsert: ${error.message}`);
        }
      }
      if (horses.length) {
        setStatus(`3/5 馬情報更新中 (${horses.length}件)...`);
        await tick();
        for (const chunk of chunkArray(horses, 1000)) {
          const { error } = await (supabase.from('horses') as any).upsert(chunk, { onConflict: 'horse_id' });
          if (error) throw new Error(`horses upsert: ${error.message}`);
        }
      }
      if (entries.length) {
        setStatus(`4/5 出走馬情報更新中 (${entries.length}件)...`);
        await tick();
        for (const chunk of chunkArray(entries, 1000)) {
          const { error } = await (supabase.from('entries') as any).upsert(chunk, { onConflict: 'race_id,horse_id' });
          if (error) throw new Error(`entries upsert: ${error.message}`);
        }
      }

      if (memosInCsv.length) {
        setStatus(`5/5 既存メモ確認中 (${memosInCsv.length}件)...`);
        await tick();
        const raceIds = Array.from(racesMap.keys());
        const existingMap = new Map();

        for (const rChunk of chunkArray(raceIds, 50)) {
          const { data: existingMemos, error: fetchErr } = await supabase
            .from('memos')
            .select('id, race_id, horse_id, user_id, race_comment, result_comment, uma_mark8')
            .in('race_id', rChunk)
            .eq('user_id', currentUserId);

          if (fetchErr) throw new Error(`memos fetch: ${fetchErr.message}`);
          if (existingMemos) {
            for (const em of existingMemos) {
              existingMap.set(`${em.race_id}_${em.horse_id}_${em.user_id}`, em);
            }
          }
        }

        const memosToUpdate: any[] = [];
        const memosToInsert: any[] = [];

        for (const m of memosInCsv) {
          const k = `${m.race_id}_${m.horse_id}_${currentUserId}`;
          const existing = existingMap.get(k);
          const hasData = m.uma_mark8 || m.race_comment || m.result_comment;

          if (existing) {
            memosToUpdate.push({
              id: existing.id,
              race_id: m.race_id,
              horse_id: m.horse_id,
              user_id: currentUserId,
              author_name: currentUserEmail,
              uma_mark8: m.uma_mark8 || existing.uma_mark8 || null,
              race_comment: m.race_comment || existing.race_comment || null,
              result_comment: m.result_comment || existing.result_comment || null,
            });
          } else if (hasData) {
            memosToInsert.push({
              race_id: m.race_id,
              horse_id: m.horse_id,
              user_id: currentUserId,
              author_name: currentUserEmail,
              uma_mark8: m.uma_mark8 || null,
              race_comment: m.race_comment || null,
              result_comment: m.result_comment || null,
            });
          }
        }

        if (memosToUpdate.length) {
          setStatus(`5/5 メモ更新中 (${memosToUpdate.length}件)...`);
          for (const chunk of chunkArray(memosToUpdate, 1000)) {
            const { error } = await (supabase.from('memos') as any).upsert(chunk, { onConflict: 'id' });
            if (error) throw new Error(`memos update: ${error.message}`);
          }
        }
        if (memosToInsert.length) {
          setStatus(`5/5 新規メモ登録中 (${memosToInsert.length}件)...`);
          for (const chunk of chunkArray(memosToInsert, 1000)) {
            const { error } = await (supabase.from('memos') as any).insert(chunk);
            if (error) throw new Error(`memos insert: ${error.message}`);
          }
        }
      }

      setStatus(`OK: 取込完了 (races:${races.length}, horses:${horses.length}, memos:${memosInCsv.length})`);
    } catch (err: any) {
      console.error(err);
      setStatus(`NG: ${err?.message ?? String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: 24, maxWidth: 980, margin: '0 auto', backgroundColor: '#e8f4fd', minHeight: '100vh' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
        }}
      >
        <h1 style={{ fontSize: 28, margin: 0 }}>CSV取り込み</h1>
        <Link
          href="/"
          style={{
            border: '1px solid #333',
            padding: '10px 14px',
            borderRadius: 8,
            textDecoration: 'none',
            color: '#111',
          }}
        >
          ← 戻る
        </Link>
      </div>

      <div style={{ marginTop: 16, border: '1px solid #bbb', borderRadius: 10, padding: 14, background: '#fff' }}>
        <div style={{ fontWeight: 800, marginBottom: 8 }}>※ 取込ファイル注意</div>
        <div style={{ lineHeight: 1.8 }}>
          <div>①A列のヘッダ名は「レースID(新)」</div>
          <div>②レースIDは馬番無しのものを使用（馬番を示す末尾の2桁が不要）</div>
          <div>③F列のヘッダ名は「芝ダ」（出走馬分析から出すと芝・ダになる）</div>
        </div>
      </div>

      <div style={{ marginTop: 18, border: '1px solid #bbb', borderRadius: 10, padding: 14, background: '#fff' }}>
        <div style={{ fontWeight: 800, marginBottom: 10, fontSize: 18 }}>CSVファイル</div>

        <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-block' }}>
            <input
              type="file"
              accept=".csv,text/csv"
              style={{ display: 'none' }}
              onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
            />
            <span
              style={{
                display: 'inline-block',
                border: '1px solid #333',
                padding: '10px 14px',
                borderRadius: 8,
                cursor: 'pointer',
              }}
            >
              ファイルを選択
            </span>
          </label>

          <div style={{ color: '#333' }}>選択中: {fileName}</div>

          <button
            type="button"
            onClick={runImport}
            disabled={busy || csvRows.length === 0}
            style={{
              border: '1px solid #999',
              padding: '10px 14px',
              borderRadius: 8,
              cursor: busy || csvRows.length === 0 ? 'not-allowed' : 'pointer',
              opacity: busy || csvRows.length === 0 ? 0.5 : 1,
              marginLeft: 8,
            }}
          >
            取り込み実行
          </button>
        </div>

        <div style={{ marginTop: 14, fontWeight: 800, fontSize: 18 }}>プレビュー（先頭5行）</div>
        <div style={{ marginTop: 8 }}>読み込み行数: {csvRows.length}</div>

        <div
          style={{
            marginTop: 10,
            border: '1px solid #ccc',
            borderRadius: 10,
            padding: 12,
            minHeight: 44,
            background: '#fafafa',
          }}
        >
          {status || 'CSVを選択してください'}
        </div>

        {preview.length > 0 ? (
          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 900, background: '#fff' }}>
              <thead>
                <tr>
                  {headers.map((h) => (
                    <th
                      key={h}
                      style={{
                        border: '1px solid #ddd',
                        padding: '6px 8px',
                        background: '#f5f5f5',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.map((r, idx) => (
                  <tr key={idx}>
                    {headers.map((h) => (
                      <td key={h} style={{ border: '1px solid #eee', padding: '6px 8px', whiteSpace: 'nowrap' }}>
                        {(r[h] ?? '').toString()}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </div>
    </div>
  );
}