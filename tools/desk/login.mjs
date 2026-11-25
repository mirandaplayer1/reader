#!/usr/bin/env node
// Signs this machine in to Reader once, with the same email and password as the web page.
// The password is not stored: only the session it returns is, in ~/.config/reader-desk/session.json.
import readline from 'readline';
import { login } from './supa.mjs';

const ask = (q, hide) => new Promise((res) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hide) rl._writeToOutput = (s) => { if (s.includes(q)) process.stdout.write(q); };
  rl.question(q, (a) => { rl.close(); if (hide) process.stdout.write('\n'); res(a.trim()); });
});

const email = process.argv[2] || await ask('Reader 的信箱：');
const password = await ask('密碼（不會顯示）：', true);
try {
  const s = await login(email, password);
  console.log('登入成功：' + s.user.email);
} catch (e) {
  console.error('沒有登入：' + (e instanceof Error ? e.message : e));
  console.error('還沒設定過密碼的話：打開 Reader 網頁，點右上角的帳號，在「設定密碼」存一組。');
  process.exit(1);
}
