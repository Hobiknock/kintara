const fs = require('fs');
const path = require('path');
const BOT = '/home/agentuser/kintara-bot';
// Patch headless-runner: mode "auto" TANPA phase2 mining — habis fase1 (semua lv5) keluar.
// Spawn via env KINTARA_NO_PHASE2=1 supaya default `auto` tak berubah.
const runner = path.join(BOT, 'tools/headless-runner.js');
let src = fs.readFileSync(runner, 'utf8');
if (!src.includes('KINTARA_NO_PHASE2')) {
  const oldLine = src.match(/\n( *)const done = await phase1ToLevel\(cli\);|const done = await phase1ToLevel5\(cli\);\n( *)if \(done\) await phase2Mining\(cli\);/);
  src = src.replace(
    'if (done) await phase2Mining(cli);',
    'if (done) { if (process.env.KINTARA_NO_PHASE2 === "1") { log("fase1 tuntas — keluar (no phase2)"); process.exit(0); } await phase2Mining(cli); }'
  );
  fs.writeFileSync(runner, src);
  console.log('patched headless-runner.js (KINTARA_NO_PHASE2 support)');
} else console.log('sudah patched');
