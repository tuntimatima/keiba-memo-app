'use client';
import { supabase } from '../lib/supabaseClient';

import Link from 'next/link';
import { useEffect, useState } from 'react';

// NOTE: ブラウザ内で Supabase クライアントが多重生成されると
// GoTrueClient の warning が出て挙動が不安定になることがあるため
// globalThis に 1 個だけキャッシュして使い回す。

type Place = string;

type RaceRow = {
  race_id: string;
  race_date: string | null; // YYYY-MM-DD
  place: string | null;
  race_no: number | null;

  // 追加（存在しない列があっても select('*') で拾う想定）
  race_name?: string | null;
  surface?: string | null;
  distance_m?: number | null;
};

type EntryRow = {
  race_id: string;
  horse_id: string;
  waku: number | null;
  umaban: number | null;
  // PostgREST の返りは環境/指定によって
  //  - object: { horse_name }
  //  - array : [{ horse_name }]
  // どちらも起こり得るので両対応にする。
  horses?: { horse_name: string | null } | { horse_name: string | null }[] | null;
};

type MemoRow = {
  id: string;
  race_id: string | null;
  horse_id: string | null;
  uma_mark8: string | null;
  race_comment: string | null;
  result_comment: string | null;
  author_name: string | null;
  created_at: string;
};

type HorseViewRow = {
  horse_id: string;
  waku: number | null;
  umaban: number | null;
  horse_name: string;
  last5: RaceRow[]; // 最新5走（最新→過去）
};

// --- MarkSelect Component ---
// 選択時の表示を即時反映（ローカルState）させるためのラッパーコンポーネント
// ※Reactの単一方向データフローによる `<select>` の「選択しても元に戻る」挙動を防ぐため
function MarkSelect({
  initialMark,
  horseId,
  authorColor,
  YOSOU_MARKS,
  onSave
}: {
  initialMark: string;
  horseId: string;
  authorColor: string;
  YOSOU_MARKS: string[];
  onSave: (horseId: string, mark: string) => void;
}) {
  const [localMark, setLocalMark] = useState(initialMark);

  useEffect(() => {
    setLocalMark(initialMark);
  }, [initialMark]);

  return (
    <select
      value={localMark}
      onChange={(e) => {
        setLocalMark(e.target.value);
        onSave(horseId, e.target.value);
      }}
      style={{
        width: 32,
        height: 24,
        padding: 0,
        backgroundColor: authorColor,
        border: '1px solid #ccc',
        borderRadius: 4,
        fontSize: 12,
        fontWeight: 800,
        cursor: 'pointer',
        color: '#111',
        appearance: 'none', // 矢印を消して省スペース化
        textAlign: 'center',
      }}
    >
      <option value="">-</option>
      {YOSOU_MARKS.map((mk) => (
        <option key={mk} value={mk}>
          {mk}
        </option>
      ))}
    </select>
  );
}

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  // auth
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  // login UI（Magic Link）
  const [loginEmail, setLoginEmail] = useState('');
  const [authBusy, setAuthBusy] = useState(false);

  // UI: 日付/開催/レース
  const [selectedDate, setSelectedDate] = useState(''); // YYYY-MM-DD
  const [availablePlaces, setAvailablePlaces] = useState<Place[]>([]);
  const [activePlace, setActivePlace] = useState<Place>('東京');
  const [activeRaceNo, setActiveRaceNo] = useState(1);
  const [activeRaceId, setActiveRaceId] = useState<string | null>(null);

  // レース表示（レース名+芝ダ+距離）
  const [raceHeaderText, setRaceHeaderText] = useState<string>('');

  // 出走馬ビュー
  const [horsesView, setHorsesView] = useState<HorseViewRow[]>([]);
  const [memosByHorseRace, setMemosByHorseRace] = useState<Record<string, MemoRow[]>>({});

  // 予想エリア（horse_id nullのメモ）
  const [raceYosous, setRaceYosous] = useState<MemoRow[]>([]);
  const [yosouModalOpen, setYosouModalOpen] = useState(false);
  const [yosouModalIndex, setYosouModalIndex] = useState<number>(1);
  const [yosouModalAuthor, setYosouModalAuthor] = useState<string>('');
  const [yosouModalEditable, setYosouModalEditable] = useState(false);
  const [yosouModalText, setYosouModalText] = useState('');

  // モーダル（セルクリックで全文）
  const [modalOpen, setModalOpen] = useState(false);
  const [modalTitle, setModalTitle] = useState('');
  const [modalRaceLabel, setModalRaceLabel] = useState('');
  const [modalItems, setModalItems] = useState<MemoRow[]>([]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg('');

      const { data: sess, error } = await supabase.auth.getSession();
      if (error) setMsg(`NG: ${error.message}`);
      setUserEmail(sess.session?.user?.email ?? null);
      setUserId(sess.session?.user?.id ?? null);

      setLoading(false);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event: any, session: any) => {
      setUserEmail(session?.user?.email ?? null);
      setUserId(session?.user?.id ?? null);
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  async function loginWithMagicLink() {
    const email = loginEmail.trim();
    if (!email) {
      setMsg('メールアドレスを入力してください');
      return;
    }
    setAuthBusy(true);
    setMsg('');

    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: {
        // 本番URL（固定）
        emailRedirectTo: 'https://keiba-memo-app.vercel.app',
      },
    });

    if (error) setMsg(`ログイン失敗: ${error.message}`);
    else setMsg('ログイン用リンクをメールに送信しました（メールを確認してください）');

    setAuthBusy(false);
  }

  async function logout() {
    setAuthBusy(true);
    setMsg('');
    const { error } = await supabase.auth.signOut();
    if (error) setMsg(`ログアウト失敗: ${error.message}`);
    setAuthBusy(false);
  }

  // ===== Helpers =====
  const YOSOU_MARKS = ['◎', '○', '▲', '△', '☆', '✓', '消'];

  async function saveUmaMark(horseId: string, mark: string) {
    if (!activeRaceId || !userEmail || !userId) return;

    const k = cellKey(horseId, activeRaceId);
    const existingMemos = memosByHorseRace[k] ?? [];
    const myMemo = existingMemos.find(m => m.author_name === userEmail);

    const payload = {
      ...(myMemo ? { id: myMemo.id } : {}),
      race_id: activeRaceId,
      horse_id: horseId,
      user_id: userId,
      author_name: userEmail,
      uma_mark8: mark || null,
      race_comment: myMemo?.race_comment ?? null,
      result_comment: myMemo?.result_comment ?? null,
    };

    const { error } = await supabase.from('memos').upsert(payload, myMemo ? { onConflict: 'id' } : undefined);
    if (error) {
      setMsg(`印の保存失敗: ${error.message}`);
    } else {
      await loadRaceView(activeRaceId);
    }
  }

  function openYosouModal(index: number, author: string, editable: boolean) {
    const yosou = raceYosous.find(y => y.author_name === author && y.uma_mark8 === `yosou_${index}`);
    setYosouModalIndex(index);
    setYosouModalAuthor(author);
    setYosouModalEditable(editable);
    setYosouModalText(yosou?.race_comment ?? '');
    setYosouModalOpen(true);
  }

  async function saveYosou() {
    if (!activeRaceId || !userEmail || !userId) return;

    const existing = raceYosous.find(y => y.author_name === userEmail && y.uma_mark8 === `yosou_${yosouModalIndex}`);
    const textToSave = yosouModalText.trim();

    const payload = {
      ...(existing ? { id: existing.id } : {}),
      race_id: activeRaceId,
      horse_id: null,
      user_id: userId,
      author_name: userEmail,
      uma_mark8: `yosou_${yosouModalIndex}`,
      race_comment: textToSave,
      result_comment: existing?.result_comment ?? null,
    };

    setAuthBusy(true);
    const { error } = await supabase.from('memos').upsert(payload, existing ? { onConflict: 'id' } : undefined);
    setAuthBusy(false);

    if (error) {
      setMsg(`予想の保存失敗: ${error.message}`);
    } else {
      setYosouModalOpen(false);
      await loadRaceView(activeRaceId);
    }
  }

  function renderYosouMarkCell(horseId: string) {
    if (!activeRaceId) return null;
    const k = cellKey(horseId, activeRaceId);
    const mList = memosByHorseRace[k] ?? [];
    const myMemo = userEmail ? mList.find(m => m.author_name === userEmail) : null;
    const othersMemos = userEmail
      ? mList.filter(m => m.author_name !== userEmail && m.uma_mark8)
      : mList.filter(m => m.uma_mark8);

    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        {userEmail ? (
          <MarkSelect
            initialMark={myMemo?.uma_mark8 ?? ''}
            horseId={horseId}
            authorColor={getAuthorColor(userEmail)}
            YOSOU_MARKS={YOSOU_MARKS}
            onSave={saveUmaMark}
          />
        ) : null}

        {othersMemos.map(m => (
          <div
            key={m.id}
            title={m.author_name ?? ''}
            style={{
              backgroundColor: getAuthorColor(m.author_name),
              border: '1px solid #ccc',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 800,
              color: '#111',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 24,
              lineHeight: '24px'
            }}
          >
            {m.uma_mark8}
          </div>
        ))}
      </div>
    );
  }

  function cellKey(horseId: string, raceId: string) {
    return `${horseId}__${raceId}`;
  }

  function normalizeMark(mark: string | null) {
    const m = (mark ?? '').trim();
    if (!m) return '';
    return m
      .replace('Ｓ', 'S')
      .replace('Ａ', 'A')
      .replace('Ｂ', 'B')
      .replace('Ｃ', 'C');
  }

  function markBadge(mark: string | null) {
    const m = normalizeMark(mark);
    if (!m) return null;
    const cls =
      m === 'S' ? 'mkS' :
        m === 'A' ? 'mkA' :
          m === 'B' ? 'mkB' :
            m === 'C' ? 'mkC' :
              m === '危' ? 'mkKiki' :
                m === '弱' ? 'mkYowa' : 'mkOther';
    return <span className={`markBadge ${cls}`}>【{m}】</span>;
  }

  function extractClassFromRaceName(name: string | null | undefined): string {
    const s = (name ?? '').toString();
    const patterns = [
      '未勝利', '新馬',
      '1勝', '1勝クラス', '2勝', '2勝クラス', '3勝', '3勝クラス',
      'オープン', 'OP', 'L', 'G1', 'G2', 'G3'
    ];
    for (const p of patterns) {
      if (s.includes(p)) return p;
    }
    return '';
  }

  function raceHeadText(r: RaceRow) {
    const d = r.race_date ?? '';
    const p = r.place ?? '';
    const n = r.race_no != null ? `${r.race_no}R` : '';
    const cls = extractClassFromRaceName(r.race_name);
    const surf = (r.surface ?? '').toString().trim();
    const dist = r.distance_m != null ? `${r.distance_m}m` : '';
    return [d, p, n, cls, surf, dist].filter(Boolean).join(' ');
  }

  function wakuStyle(waku: number | null): { background: string; color: string; border: string } {
    const w = waku ?? 0;
    const map: Record<number, { bg: string; fg: string; bd: string }> = {
      1: { bg: '#ffffff', fg: '#111111', bd: '#999999' },
      2: { bg: '#111111', fg: '#ffffff', bd: '#111111' },
      3: { bg: '#e53935', fg: '#ffffff', bd: '#c62828' },
      4: { bg: '#1e88e5', fg: '#ffffff', bd: '#1565c0' },
      5: { bg: '#fdd835', fg: '#111111', bd: '#f9a825' },
      6: { bg: '#43a047', fg: '#ffffff', bd: '#2e7d32' },
      7: { bg: '#fb8c00', fg: '#111111', bd: '#ef6c00' },
      8: { bg: '#f48fb1', fg: '#111111', bd: '#f06292' },
    };
    const c = map[w] ?? { bg: '#ffffff', fg: '#111111', bd: '#999999' };
    return { background: c.bg, color: c.fg, border: c.bd };
  }

  function getAuthorColor(authorName: string | null): string {
    if (!authorName) return 'rgba(227, 242, 253, 0.8)'; // デフォルトの青系
    let hash = 0;
    for (let i = 0; i < authorName.length; i++) {
      hash = authorName.charCodeAt(i) + ((hash << 5) - hash);
    }
    const hue = Math.abs(hash * 137) % 360;
    return `hsla(${hue}, 80%, 90%, 0.8)`;
  }

  // ===== Races =====
  async function fetchPlacesByDate(dateISO: string): Promise<Place[]> {
    if (!dateISO) return [];
    const { data, error } = await supabase
      .from('races')
      .select('place')
      .eq('race_date', dateISO);

    if (error) {
      setMsg(`NG: races places lookup: ${error.message}`);
      return [];
    }

    return Array.from(
      new Set((data ?? []).map((r: any) => (r.place ?? '').toString().trim()).filter(Boolean))
    );
  }

  async function resolveRaceId(dateISO: string, place: Place, raceNo: number): Promise<string | null> {
    if (!dateISO || !place) return null;
    const { data, error } = await supabase
      .from('races')
      .select('race_id')
      .eq('race_date', dateISO)
      .eq('place', place)
      .eq('race_no', raceNo)
      .limit(1);

    if (error) {
      setMsg(`NG: races lookup: ${error.message}`);
      return null;
    }
    return data?.[0]?.race_id ?? null;
  }

  async function fetchRaceHeader(raceId: string) {
    const { data, error } = await supabase
      .from('races')
      .select('race_name,surface,distance_m')
      .eq('race_id', raceId)
      .limit(1);

    if (error) {
      setMsg(`NG: races header load: ${error.message}`);
      setRaceHeaderText('');
      return;
    }

    const r: any = data?.[0] ?? null;
    const name = (r?.race_name ?? '').toString().trim();
    const surface = (r?.surface ?? '').toString().trim();
    const dist = r?.distance_m != null ? `${r.distance_m}m` : '';
    setRaceHeaderText(`${name} ${surface} ${dist}`.trim());
  }

  // ===== Main loader (entriesベース + 最新5走) =====
  async function loadRaceView(raceId: string) {
    setLoading(true);
    setMsg('');
    await fetchRaceHeader(raceId);

    const { data: entries, error: eErr } = await supabase
      .from('entries')
      .select('race_id,horse_id,waku,umaban,horses:horses(horse_name)')
      .eq('race_id', raceId)
      .order('umaban', { ascending: true });

    // デバッグ（必要な時だけ見ればOK）
    console.log('[DEBUG] entries[0]=', (entries ?? [])[0]);

    if (eErr) {
      setLoading(false);
      setMsg(`NG: entries load: ${eErr.message}`);
      setHorsesView([]);
      setMemosByHorseRace({});
      return;
    }

    const ent = (entries ?? []) as EntryRow[];
    const horseIds = Array.from(new Set(ent.map((x) => x.horse_id).filter(Boolean)));

    if (horseIds.length === 0) {
      setLoading(false);
      setMsg('NG: entries が0件です（このrace_idに出走馬がありません）');
      setHorsesView([]);
      setMemosByHorseRace({});
      return;
    }

    // === 馬名解決（ここが今回の本丸） ===
    // 埋め込み horses が object/array どちらでも拾う
    const horseNameMap = new Map<string, string>();
    for (const x of ent) {
      const h: any = (x as any).horses;
      const name = Array.isArray(h) ? h?.[0]?.horse_name : h?.horse_name;
      if (typeof name === 'string' && name.trim()) horseNameMap.set(x.horse_id, name.trim());
    }

    // 取りこぼしがあれば horses テーブルから直接引いて補完
    const missingIds = horseIds.filter((id) => !horseNameMap.has(id));
    if (missingIds.length > 0) {
      const { data: hrows, error: hErr } = await supabase
        .from('horses')
        .select('horse_id,horse_name')
        .in('horse_id', missingIds);

      console.log('[DEBUG] horses direct missing=', missingIds.length, 'err=', hErr);

      if (!hErr) {
        (hrows ?? []).forEach((hr: any) => {
          const hid = (hr?.horse_id ?? '').toString();
          const hn = (hr?.horse_name ?? '').toString();
          if (hid && hn) horseNameMap.set(hid, hn);
        });
      }
    }

    const { data: histEntries, error: heErr } = await supabase
      .from('entries')
      .select('horse_id,race_id')
      .in('horse_id', horseIds);

    if (heErr) {
      setLoading(false);
      setMsg(`NG: entries history load: ${heErr.message}`);
      setHorsesView([]);
      setMemosByHorseRace({});
      return;
    }

    const he = (histEntries ?? []) as { horse_id: string; race_id: string }[];
    const allRaceIds = Array.from(new Set(he.map((x) => x.race_id).filter(Boolean)));

    const { data: races, error: rErr } = await supabase
      .from('races')
      .select('*')
      .in('race_id', allRaceIds);

    if (rErr) {
      setLoading(false);
      setMsg(`NG: races load: ${rErr.message}`);
      setHorsesView([]);
      setMemosByHorseRace({});
      return;
    }

    const raceMap = new Map<string, RaceRow>();
    (races ?? []).forEach((r: any) => {
      raceMap.set(r.race_id, {
        race_id: r.race_id,
        race_date: r.race_date ?? null,
        place: r.place ?? null,
        race_no: r.race_no ?? null,
        race_name: r.race_name ?? null,
        surface: r.surface ?? null,
        distance_m: r.distance_m ?? null,
      });
    });

    const racesByHorse: Record<string, RaceRow[]> = {};
    for (const x of he) {
      const rr = raceMap.get(x.race_id);
      if (!rr) continue;
      if (!racesByHorse[x.horse_id]) racesByHorse[x.horse_id] = [];
      racesByHorse[x.horse_id].push(rr);
    }

    const { data: currentRaceData } = await supabase
      .from('races')
      .select('race_date,race_no')
      .eq('race_id', raceId)
      .single();

    const targetDate = currentRaceData?.race_date ?? '9999-12-31';
    const targetNo = currentRaceData?.race_no ?? 999;

    for (const hid of Object.keys(racesByHorse)) {
      const pastRaces = racesByHorse[hid].filter(r => {
        const rd = r.race_date ?? '';
        const rn = r.race_no ?? 0;
        if (rd < targetDate) return true;
        if (rd === targetDate && rn < targetNo) return true;
        return false;
      });

      pastRaces.sort((a, b) => {
        const ad = a.race_date ?? '';
        const bd = b.race_date ?? '';
        if (ad !== bd) return ad < bd ? 1 : -1;
        const an = a.race_no ?? 0;
        const bn = b.race_no ?? 0;
        return bn - an;
      });
      racesByHorse[hid] = pastRaces.slice(0, 5);
    }

    const last5RaceIds = Array.from(
      new Set(horseIds.flatMap((hid) => (racesByHorse[hid] ?? []).map((rr) => rr.race_id)))
    );

    const fetchRaceIds = Array.from(new Set([...last5RaceIds, raceId]));

    const { data: memos, error: mErr } = await supabase
      .from('memos')
      .select('id,race_id,horse_id,uma_mark8,race_comment,result_comment,author_name,created_at')
      .in('race_id', fetchRaceIds)
      .order('created_at', { ascending: false });

    if (mErr) {
      setLoading(false);
      setMsg(`NG: memos load: ${mErr.message}`);
      setHorsesView([]);
      setMemosByHorseRace({});
      setRaceYosous([]);
      return;
    }

    const memMap: Record<string, MemoRow[]> = {};
    const yosouArr: MemoRow[] = [];
    (memos ?? []).forEach((mm: any) => {
      if (!mm.horse_id) {
        if (mm.race_id === raceId && mm.uma_mark8?.startsWith('yosou_')) {
          yosouArr.push(mm);
        }
        return;
      }
      if (!mm.race_id) return;
      const k = cellKey(mm.horse_id, mm.race_id);
      (memMap[k] ??= []).push({
        id: mm.id,
        race_id: mm.race_id,
        horse_id: mm.horse_id,
        uma_mark8: mm.uma_mark8 ?? null,
        race_comment: mm.race_comment ?? null,
        result_comment: mm.result_comment ?? null,
        author_name: mm.author_name ?? null,
        created_at: mm.created_at,
      });
    });

    const view: HorseViewRow[] = ent.map((x) => ({
      horse_id: x.horse_id,
      waku: x.waku ?? null,
      umaban: x.umaban ?? null,
      horse_name: (horseNameMap.get(x.horse_id) ?? '(不明)') as string,
      last5: racesByHorse[x.horse_id] ?? [],
    }));

    setHorsesView(view);
    setMemosByHorseRace(memMap);
    setRaceYosous(yosouArr);
    setLoading(false);
    setMsg(`OK: 出走馬 ${view.length}頭 / 最新5走メモ表示`);
  }

  async function applyRaceFilter(dateISO: string, place: Place, raceNo: number) {
    setMsg('');
    setLoading(true);

    const rid = await resolveRaceId(dateISO, place, raceNo);
    setActiveRaceId(rid);

    if (!rid) {
      setLoading(false);
      setHorsesView([]);
      setMemosByHorseRace({});
      setRaceYosous([]);
      setRaceHeaderText('');
      setMsg(`NG: races に該当なし（${dateISO} / ${place} / ${raceNo}R）`);
      return;
    }

    await loadRaceView(rid);
  }

  // ===== Modal =====
  function openCellModal(h: HorseViewRow, r: RaceRow) {
    const k = cellKey(h.horse_id, r.race_id);
    const items = memosByHorseRace[k] ?? [];
    setModalTitle(`${h.horse_name}（枠${h.waku ?? '-'} / 馬${h.umaban ?? '-'}）`);
    setModalRaceLabel(raceHeadText(r));
    setModalItems(items);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setModalItems([]);
    setModalTitle('');
    setModalRaceLabel('');
  }

  return (
    <>
      <style jsx global>{`
        body { font-family: "Hiragino Sans","Meiryo",sans-serif; margin:0; background:#f0f0f0; font-size:11px; color:#111; }
        input, textarea, button { color:#111; }
        input::placeholder, textarea::placeholder { color:#777; opacity:1; }

        .header-nav { background:#fff; border-bottom:2px solid #222; padding:8px 12px; display:flex; align-items:center; justify-content:space-between; }
        .header-left { display:flex; align-items:center; gap:16px; flex-wrap:wrap; }
        .date-input-area { display:flex; align-items:center; gap:8px; }
        .date-field { padding:5px; border:1px solid #ccc; border-radius:4px; width:140px; }

        .import-btn { background:#4caf50; color:#fff; border:none; padding:8px 24px; border-radius:50px; font-weight:bold; cursor:pointer; font-size:12px; box-shadow:0 2px 4px rgba(0,0,0,.2); transition:.2s; text-decoration:none; display:inline-block; }
        .import-btn:hover { background:#45a049; transform: translateY(-1px); }

        .pill { font-size:12px; opacity:.9; }

        .place-tabs { display:flex; gap:5px; }
        .place-btn { padding:5px 15px; border:1px solid #ccc; background:#fff; cursor:pointer; border-radius:3px; }
        .place-btn.active { background:#666; color:#fff; }

        .race-btn-container { display:flex; gap:1px; background:#ddd; padding:4px; border-bottom:1px solid #aaa; }
        .race-btn { flex:1; padding:8px 0; border:1px solid #bbb; background:#fff; font-weight:bold; cursor:pointer; }
        .race-btn.active { background:#ffeb3b; border-color:#fbc02d; }

        .wrap { padding:12px; }

        .uma-table { width:100%; border-collapse:collapse; background:#fff; table-layout:fixed; }
        .uma-table th { background:#555; color:#fff; padding:6px; border:1px solid #333; font-size:11px; }
        .uma-table td { border:1px solid #ccc; overflow:hidden; color:#111; }

        .centerCell { text-align:center; vertical-align: middle; font-weight:800; }
        .nameCell { vertical-align: middle; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding: 0 8px; }

        .cell { cursor:pointer; }
        .race-head { background:#f2f2f2; padding:2px 4px; font-size:10px; border-bottom:1px solid #eee; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .memo-box { padding:2px 4px; border-bottom:1px dotted #ddd; }
        .memo-line { font-size:10px; line-height:1.2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
        .race-comm { background:#fff9c4; }
        .res-comm { background:#e3f2fd; font-weight: bold; }

        .markBadge {
          display: inline-block;
          padding: 0px 6px;
          border-radius: 999px;
          font-weight: 900;
          margin-right: 6px;
          line-height: 1.6;
        }
        .mkS { background:#b71c1c; color:#fff; }
        .mkA { background:#ef6c00; color:#fff; }
        .mkB { background:#1565c0; color:#fff; }
        .mkC { background:#2e7d32; color:#fff; }
        .mkKiki { background:#6a1b9a; color:#fff; }
        .mkYowa { background:#e0e0e0; color:#111; }
        .mkOther { background:#eeeeee; color:#111; }

        .modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); z-index:999; display:flex; align-items:center; justify-content:center; }
        #floatWindow { width:560px; background:#fff; border:1px solid #000; box-shadow:0 4px 20px rgba(0,0,0,.4); border-radius:4px; }
        .fw-header { background:#444; color:#fff; padding:8px 12px; font-weight:bold; display:flex; justify-content:space-between; }
        .fw-body { padding:12px; max-height:560px; overflow-y:auto; }
        .fw-text { font-size:12px; line-height:1.4; white-space:pre-wrap; border-left:3px solid #ccc; padding-left:8px; margin-bottom:10px; color:#111; }
        .item { border:1px solid #ddd; border-radius:6px; padding:8px; margin-bottom:8px; }
        .item-top { display:flex; justify-content:space-between; gap:10px; font-size:11px; opacity:.85; margin-bottom:6px; }
      `}</style>

      <div className="header-nav">
        <div className="header-left">
          <div className="date-input-area">
            <label>日付:</label>
            <input
              type="date"
              className="date-field"
              value={selectedDate}
              onChange={async (e) => {
                const v = e.target.value;
                setSelectedDate(v);

                if (!v) {
                  setAvailablePlaces([]);
                  setActiveRaceId(null);
                  setRaceHeaderText('');
                  setHorsesView([]);
                  setMemosByHorseRace({});
                  setRaceYosous([]);
                  setMsg('');
                  return;
                }

                const places = await fetchPlacesByDate(v);
                setAvailablePlaces(places);

                const nextPlace = places.includes(activePlace) ? activePlace : (places[0] ?? activePlace);
                setActivePlace(nextPlace);

                await applyRaceFilter(v, nextPlace, activeRaceNo);
              }}
            />
          </div>

          <div className="place-tabs">
            {availablePlaces.length ? (
              availablePlaces.map((p) => (
                <button
                  key={p}
                  className={`place-btn ${activePlace === p ? 'active' : ''}`}
                  onClick={async () => {
                    setActivePlace(p);
                    if (selectedDate) await applyRaceFilter(selectedDate, p, activeRaceNo);
                  }}
                  type="button"
                >
                  {p}
                </button>
              ))
            ) : (
              <span className="pill">日付を選択してください</span>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="pill">ログイン: {userEmail ?? '(未ログイン)'}</div>

            {userEmail ? (
              <button
                type="button"
                onClick={logout}
                disabled={authBusy}
                className="pill"
                style={{ cursor: 'pointer' }}
              >
                ログアウト
              </button>
            ) : (
              <>
                <input
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="メールアドレス"
                  style={{
                    height: 32,
                    padding: '0 10px',
                    border: '1px solid #ccc',
                    borderRadius: 8,
                    minWidth: 220,
                  }}
                />
                <button
                  type="button"
                  onClick={loginWithMagicLink}
                  disabled={authBusy}
                  style={{
                    height: 32,
                    padding: '0 12px',
                    borderRadius: 8,
                    border: '1px solid #16a34a',
                    background: '#16a34a',
                    color: '#fff',
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  メールでログイン
                </button>
              </>
            )}
          </div>
        </div>

        <Link className="import-btn" href="/import">
          メモ取り込み
        </Link>
      </div>

      <div className="race-btn-container">
        {Array.from({ length: 12 }, (_, i) => i + 1).map((r) => (
          <button
            key={r}
            className={`race-btn ${activeRaceNo === r ? 'active' : ''}`}
            onClick={async () => {
              setActiveRaceNo(r);
              if (selectedDate && activePlace) await applyRaceFilter(selectedDate, activePlace, r);
            }}
            type="button"
          >
            {r}R
          </button>
        ))}
      </div>

      <div className="wrap">
        {raceHeaderText ? (
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
            <div style={{ fontWeight: 900, fontSize: 14 }}>
              {raceHeaderText}
            </div>

            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
              {userEmail && (
                <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  {[1].map(btnIndex => {
                    const myYosou = raceYosous.find(y => y.author_name === userEmail && y.uma_mark8 === `yosou_${btnIndex}`);
                    const hasText = !!myYosou?.race_comment?.trim();
                    const bgColor = hasText ? getAuthorColor(userEmail) : '#fff';
                    return (
                      <button
                        key={`my_${btnIndex}`}
                        onClick={() => openYosouModal(btnIndex, userEmail, true)}
                        style={{
                          backgroundColor: bgColor,
                          border: '1px solid #999',
                          borderRadius: 4,
                          padding: '2px 12px',
                          cursor: 'pointer',
                          fontWeight: 800,
                          color: '#111'
                        }}
                      >
                        予想
                      </button>
                    )
                  })}
                </div>
              )}

              {Array.from(new Set(
                raceYosous
                  .filter(y => y.author_name && y.author_name !== userEmail && y.race_comment?.trim())
                  .map(y => y.author_name!)
              )).map(author => (
                <div key={author} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                  <span style={{ fontSize: 10 }}>{author.split('@')[0]}:</span>
                  {[1].map(btnIndex => {
                    const theirYosou = raceYosous.find(y => y.author_name === author && y.uma_mark8 === `yosou_${btnIndex}`);
                    if (!theirYosou?.race_comment?.trim()) return null;
                    return (
                      <button
                        key={`${author}_${btnIndex}`}
                        onClick={() => openYosouModal(btnIndex, author, false)}
                        style={{
                          backgroundColor: getAuthorColor(author),
                          border: '1px solid #ccc',
                          borderRadius: 4,
                          padding: '2px 12px',
                          cursor: 'pointer',
                          fontWeight: 800,
                          color: '#111'
                        }}
                      >
                        予想
                      </button>
                    )
                  })}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {msg ? (
          <div style={{ marginBottom: 10, padding: 10, border: '1px solid #333', borderRadius: 8, background: '#fff' }}>
            {msg}
          </div>
        ) : null}

        <table className="uma-table">
          <thead>
            <tr>
              <th style={{ width: 54 }}>枠</th>
              <th style={{ width: 54 }}>馬</th>
              <th style={{ width: 154 }}>馬名</th>
              <th style={{ width: 80 }}>印</th>
              <th colSpan={5}>最新5走メモ（クリックで全文）</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr><td colSpan={9} style={{ padding: 12, opacity: 0.7 }}>Loading...</td></tr>
            ) : horsesView.length === 0 ? (
              <tr><td colSpan={9} style={{ padding: 12, opacity: 0.7 }}>表示する馬がありません（レースを選択してください）</td></tr>
            ) : (
              horsesView.map((h) => {
                const w = wakuStyle(h.waku);
                const cols: (RaceRow | null)[] = [];
                for (let i = 0; i < 5; i++) cols.push(h.last5[i] ?? null);

                return (
                  <tr key={h.horse_id}>
                    <td className="centerCell" style={{ background: w.background, color: w.color, borderColor: w.border }}>
                      {h.waku ?? '-'}
                    </td>
                    <td className="centerCell">{h.umaban ?? '-'}</td>
                    <td className="nameCell" title={h.horse_name}>{h.horse_name}</td>

                    <td className="cell" style={{ verticalAlign: 'top', padding: 4 }}>
                      {renderYosouMarkCell(h.horse_id)}
                    </td>

                    {cols.map((r, idx) => {
                      if (!r) return <td key={idx} style={{ opacity: 0.5, textAlign: 'center', verticalAlign: 'middle' }}>-</td>;

                      const k = cellKey(h.horse_id, r.race_id);
                      const items = memosByHorseRace[k] ?? [];

                      return (
                        <td key={r.race_id} className="cell" onClick={() => openCellModal(h, r)} role="button">
                          <div className="race-head">{raceHeadText(r)}</div>

                          {items.length === 0 ? (
                            <div className="memo-box" style={{ opacity: 0.6 }}>（メモなし）</div>
                          ) : (
                            items.map((m) => (
                              <div key={m.id} className="memo-box">
                                <div className="memo-line race-comm">
                                  {markBadge(m.uma_mark8)}
                                  {m.race_comment ?? ''}
                                </div>
                                <div className="memo-line res-comm" style={{ backgroundColor: getAuthorColor(m.author_name) }}>{m.result_comment ?? ''}</div>
                              </div>
                            ))
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {modalOpen ? (
        <div className="modal-overlay" onClick={closeModal}>
          <div id="floatWindow" onClick={(e) => e.stopPropagation()}>
            <div className="fw-header">
              <span>{modalTitle}</span>
              <span style={{ cursor: 'pointer' }} onClick={closeModal}>✕</span>
            </div>
            <div className="fw-body">
              <div style={{ fontWeight: 800, marginBottom: 8 }}>{modalRaceLabel}</div>

              {modalItems.length === 0 ? (
                <div style={{ opacity: 0.7 }}>メモがありません</div>
              ) : (
                modalItems.map((m) => (
                  <div className="item" key={m.id}>
                    <div className="item-top">
                      <div>{m.author_name ? `by ${m.author_name}` : '(投稿者不明)'}</div>
                      <div>{new Date(m.created_at).toLocaleString()}</div>
                    </div>
                    <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 4 }}>Rコメント</div>
                    <div className="fw-text">{m.race_comment ?? ''}</div>
                    <div style={{ fontSize: 11, fontWeight: 800, marginBottom: 4 }}>結果コメント</div>
                    <div className="fw-text" style={{ backgroundColor: getAuthorColor(m.author_name), padding: '6px 8px', borderRadius: '0 4px 4px 0' }}>{m.result_comment ?? ''}</div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      {yosouModalOpen ? (
        <div className="modal-overlay" onClick={() => setYosouModalOpen(false)}>
          <div id="floatWindow" onClick={(e) => e.stopPropagation()} style={{ width: 400 }}>
            <div className="fw-header">
              <span>{yosouModalAuthor === userEmail ? `予想の編集` : `${yosouModalAuthor?.split('@')[0]}の予想`}</span>
              <span style={{ cursor: 'pointer' }} onClick={() => setYosouModalOpen(false)}>✕</span>
            </div>
            <div className="fw-body">
              <div style={{ fontWeight: 800, marginBottom: 8 }}>{raceHeaderText}</div>
              {yosouModalEditable ? (
                <>
                  <textarea
                    value={yosouModalText}
                    onChange={(e) => setYosouModalText(e.target.value)}
                    style={{ width: '100%', height: 160, padding: 8, boxSizing: 'border-box', border: '1px solid #ccc', borderRadius: 4, resize: 'vertical' }}
                    placeholder="予想を自由に入力..."
                  />
                  <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                    <button type="button" onClick={() => setYosouModalOpen(false)} style={{ padding: '6px 12px', cursor: 'pointer', border: '1px solid #ccc', background: '#fff', borderRadius: 4 }}>キャンセル</button>
                    <button type="button" onClick={saveYosou} disabled={authBusy} style={{ padding: '6px 12px', background: '#16a34a', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 800 }}>保存</button>
                  </div>
                </>
              ) : (
                <div className="fw-text" style={{ whiteSpace: 'pre-wrap' }}>
                  {yosouModalText}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}


