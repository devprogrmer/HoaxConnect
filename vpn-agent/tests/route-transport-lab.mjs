import { readFile, writeFile } from 'node:fs/promises';
import { RouteTransport } from '../dist/route-transport.js';
const [role, stateDir, groupPath, flagPath] = process.argv.slice(2);
const group = JSON.parse(await readFile(groupPath, 'utf8'));
const transport = new RouteTransport(stateDir, 'hcx0', role === 'gateway' ? 'eth0' : 'under0');
if (role === 'gateway') {
  await transport.reconcile([group]);
  await writeFile(`${flagPath}.ready`, 'ready');
  const timer = setInterval(async () => {
    try {
      const value = (await readFile(flagPath, 'utf8')).trim();
      if (value === 'active' && group.phase !== 'active') {
        group.phase = 'active'; await transport.reconcile([group]);
        await writeFile(`${flagPath}.active`, 'active');
      }
      if (value === 'withdraw') {
        await transport.withdraw(); clearInterval(timer);
        await writeFile(`${flagPath}.withdrawn`, 'withdrawn');
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }, 200);
} else {
  await transport.reconcile([group]);
  if (group.phase === 'staging') {
    let healthy = false;
    for (let i = 0; i < 20 && !healthy; i++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      healthy = await transport.health(group);
    }
    if (!healthy) throw new Error('Encrypted link and UDP round-trip did not become healthy');
    console.log('ROUTE_STAGE_HEALTHY');
  } else console.log('ROUTE_ACTIVE');
}
