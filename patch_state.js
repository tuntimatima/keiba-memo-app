const fs = require('fs');

const P = 'app/page.tsx';
let s = fs.readFileSync(P, 'utf8');

// 既に loginEmail が定義されてたら何もしない
if (/const \[loginEmail,\s*setLoginEmail\]/.test(s)) {
  console.log('state already exists');
  process.exit(0);
}

// userEmail の state の直後に追加（より広いパターンで探す）
const re = /const \[userEmail,\s*setUserEmail\]\s*=\s*useState<[^;]+;\s*\n/;

if (!re.test(s)) {
  console.error('could not find userEmail state line');
  process.exit(1);
}

s = s.replace(re, (m) =>
  m +
  "  const [loginEmail, setLoginEmail] = useState('');\n" +
  "  const [authBusy, setAuthBusy] = useState(false);\n"
);

fs.writeFileSync(P, s, 'utf8');
console.log('state patched');
