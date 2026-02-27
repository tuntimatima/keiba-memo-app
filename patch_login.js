const fs = require('fs');

const SRC = 'app/page_backup.tsx';
const DST = 'app/page.tsx';

let s = fs.readFileSync(SRC, 'utf8');

// 既に入ってたら終了
if (/signInWithOtp|loginEmail|メールでログイン|ログアウト/.test(s)) {
  console.log('already has login UI');
  process.exit(0);
}

// 1) state 追加（userEmail の直後）
s = s.replace(
  /const \[userEmail, setUserEmail\] = useState<[^\\n]+\\n/,
  (m) => m + "  const [loginEmail, setLoginEmail] = useState('');\n  const [authBusy, setAuthBusy] = useState(false);\n"
);

// 2) useEffect ブロックの直後に関数追加（最初に出てくる useEffect の後ろ）
s = s.replace(
  /\n\s*useEffect\([\s\S]*?\);\s*\n/,
  (m) => m +
`  async function loginWithMagicLink() {
    const email = loginEmail.trim();
    if (!email) { setMsg('メールアドレスを入力してください'); return; }
    setAuthBusy(true); setMsg('');
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: 'https://keiba-memo-app.vercel.app' },
    });
    if (error) setMsg('ログイン失敗: ' + error.message);
    else setMsg('ログイン用リンクをメールに送信しました（メールを確認してください）');
    setAuthBusy(false);
  }

  async function logout() {
    setAuthBusy(true); setMsg('');
    const { error } = await supabase.auth.signOut();
    if (error) setMsg('ログアウト失敗: ' + error.message);
    setAuthBusy(false);
  }

`
);

// 3) pill行を置換（完全一致じゃない場合があるので「ログイン:」を含むpillを狙う）
s = s.replace(
  /<div className="pill">ログイン:[\s\S]*?<\/div>/,
  `<div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="pill">ログイン: {userEmail ?? '(未ログイン)'}</div>

            {userEmail ? (
              <button type="button" onClick={logout} disabled={authBusy} className="pill" style={{ cursor: 'pointer' }}>
                ログアウト
              </button>
            ) : (
              <>
                <input
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="メールアドレス"
                  style={{ height: 32, padding: '0 10px', border: '1px solid #ccc', borderRadius: 8, minWidth: 220 }}
                />
                <button
                  type="button"
                  onClick={loginWithMagicLink}
                  disabled={authBusy}
                  style={{ height: 32, padding: '0 12px', borderRadius: 8, border: '1px solid #16a34a', background: '#16a34a', color: '#fff', fontWeight: 800, cursor: 'pointer' }}
                >
                  メールでログイン
                </button>
              </>
            )}
          </div>`
);

fs.writeFileSync(DST, s, 'utf8');
console.log('patched');
