// 守护进程自愈验证：刷新渲染页，检查皮肤是否被守护进程补注
const { connectRenderer } = require('../src/cdp');

const PORT = Number(process.argv[2] || 9335);

async function main() {
  const s1 = await connectRenderer(PORT);
  await s1.send('Page.enable');
  console.log('刷新前皮肤状态:', JSON.stringify(await s1.evaluate('(() => window.__zdsApplied || null)()')));
  await s1.send('Page.reload', { ignoreCache: false });
  s1.close();

  // 等页面重载 + 守护进程补注
  await new Promise((r) => setTimeout(r, 12000));

  for (let i = 0; i < 10; i++) {
    try {
      const s2 = await connectRenderer(PORT);
      const st = await s2.evaluate('(() => window.__zdsApplied || null)()');
      s2.close();
      console.log(`第 ${i + 1} 次检查:`, JSON.stringify(st));
      if (st) { console.log('PASS: 守护进程已补注皮肤'); process.exit(0); }
    } catch (e) {
      console.log(`第 ${i + 1} 次检查: 页面未就绪 (${e.message})`);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log('FAIL: 刷新后皮肤未恢复');
  process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
