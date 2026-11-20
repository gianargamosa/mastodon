#!/usr/bin/env node
// A pretend agent that reports its state over OSC 7501, for trying out the
// sidebar without spending tokens:  mas -- node examples/status-demo.js
//
// It probes for support, "works" with rising progress, asks for permission,
// then finishes — or fails if you answer n.

const b64 = (text) => Buffer.from(text).toString('base64');
const report = (pairs) => process.stdout.write(`\x1b]7501;${pairs}\x1b\\`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();

let supported = false;
let answer = null;
process.stdin.on('data', (key) => {
  if (key.includes('\x1b]7501;?')) supported = true;
  else if (key === '\x03') process.exit(130);
  else if (answer) answer(key);
});

async function main() {
  process.stdout.write('\x1b]7501;?\x1b\\');
  await sleep(300);
  console.log(supported ? 'Terminal speaks OSC 7501 ✓' : 'No OSC 7501 support detected — running without status.');

  for (;;) {
    console.log('\nBuilding pages… (switch to another session to see the sidebar update)');
    for (let progress = 0; progress <= 100; progress += 10) {
      report(`state=working:progress=${progress}:msg=${b64(`Building pages ${progress}%`)}`);
      await sleep(600);
    }

    report(`state=blocked:kind=permission:msg=${b64('Allow npm install?')}`);
    process.stdout.write('Allow npm install? [y/n] ');
    const key = await new Promise((resolve) => (answer = resolve));
    answer = null;
    console.log(key);

    report('state=working');
    await sleep(1500);
    if (key.toLowerCase() === 'y') {
      report(`state=done:msg=${b64('Built 3 pages')}`);
      console.log('Done — built 3 pages.');
    } else {
      report(`state=error:msg=${b64('Install was not allowed')}`);
      console.log('Stopped: install was not allowed.');
    }

    process.stdout.write('\nPress any key to run again, Ctrl+C to quit. ');
    await new Promise((resolve) => (answer = resolve));
    answer = null;
  }
}

main();
