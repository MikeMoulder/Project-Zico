// Bundle one run into a single self-contained HTML file.
//
// This is only possible because the graph is a projection of an append-only
// event log: replaying the events in order reproduces the run exactly, so the
// same visualiser that renders live can render from a frozen log with no
// server, no wallet, and no network. The export is a file, not a service.

import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param events  the full event log
 * @param taskId  run to export, or null for the most recent
 * @param speed   replay rate — 1 = original timing, 0 = instant
 */
export async function exportRun({ events, taskId = null, out, speed = 1 }) {
  const tasks = events.filter((e) => e.type === 'task_created');
  if (!tasks.length) throw new Error('no runs to export');

  const target = taskId ?? tasks[tasks.length - 1].taskId;
  const slice = events.filter((e) => e.taskId === target);
  if (!slice.length) throw new Error(`no events for ${target}`);

  const created = slice.find((e) => e.type === 'task_created');
  const title = created?.prompt ?? target;
  const mode = created?.mode ?? slice.find((e) => e.type === 'payment')?.mode ?? 'recorded';

  // Rebase timestamps so replay starts at zero regardless of when it ran.
  const t0 = slice[0].ts;
  const frames = slice.map((e) => ({ ...e, at: e.ts - t0 }));

  const shell = await readFile(join(ROOT, 'web', 'index.html'), 'utf8');
  const html = shell.replace(
    '<script>',
    `<script>
/* ── frozen run, injected at export time ─────────────────────────────────── */
window.ZICO_REPLAY = ${JSON.stringify({ taskId: target, title, mode, speed, frames })};
window.fetch = () => new Promise(() => {});   // no server behind this file
</script>
<script>`,
  );

  const file = out ?? `zico-${target}.html`;
  await writeFile(file, withReplayDriver(html), 'utf8');
  return { file, taskId: target, events: frames.length, title };
}

/**
 * Swap the live EventSource for a timed replay of the frozen log, and add the
 * transport controls a viewer needs when there is no agent driving.
 */
function withReplayDriver(html) {
  const driver = `
<div id="replayBar">
  <button id="rpPlay" title="play / pause">&#9654;</button>
  <button id="rpBack" title="restart">&#8635;</button>
  <input id="rpSeek" type="range" min="0" max="1000" value="0" step="1">
  <span id="rpTime" class="num">0.0s</span>
  <select id="rpSpeed" aria-label="speed">
    <option value="0.5">0.5&times;</option>
    <option value="1" selected>1&times;</option>
    <option value="2">2&times;</option>
    <option value="4">4&times;</option>
    <option value="0">skip</option>
  </select>
  <span class="rp-label">REPLAY</span>
</div>
<style>
#replayBar{position:absolute;left:50%;transform:translateX(-50%);bottom:18px;z-index:40;
  display:flex;align-items:center;gap:10px;padding:8px 14px;
  background:rgba(10,12,16,.86);backdrop-filter:blur(14px);
  border:1px solid var(--line-2);border-radius:8px;
  box-shadow:0 12px 32px rgba(0,0,0,.6)}
#replayBar button{background:none;border:1px solid var(--line-2);border-radius:4px;
  color:var(--ink-2);width:26px;height:26px;cursor:pointer;font-size:11px;line-height:1}
#replayBar button:hover{color:var(--ink);border-color:var(--line-3)}
#rpSeek{width:220px;accent-color:var(--run);cursor:pointer}
#rpTime{font-size:10.5px;color:var(--ink-3);min-width:44px;text-align:right}
#rpSpeed{font-size:10px;padding:3px 5px}
.rp-label{font-size:8.5px;font-weight:600;letter-spacing:.14em;color:var(--ink-4);
  border-left:1px solid var(--line-2);padding-left:10px}
</style>
<script>
(function(){
  const R = window.ZICO_REPLAY;
  if (!R) return;
  const frames = R.frames, span = frames[frames.length-1].at || 1;
  let i = 0, clock = 0, playing = true, rate = R.speed || 1, last = performance.now();

  const $ = (id) => document.getElementById(id);
  const reset = () => {
    i = 0; clock = 0;
    nodes.clear(); tasks.clear();
    for (const el of [...world.children]) el.remove();
    $('feed').innerHTML = ''; edgeSig = ''; drawn.clear();
    selected = null; currentTask = null;
    $('inspector').innerHTML = '<div class="none">select a node</div>';
    mark(); stats(); runList();
  };

  const seekTo = (ms) => {
    if (ms < clock) reset();
    while (i < frames.length && frames[i].at <= ms) apply(frames[i++]);
    clock = ms;
    $('rpSeek').value = Math.round((clock/span)*1000);
    $('rpTime').textContent = (clock/1000).toFixed(1) + 's';
    mark(); stats(); runList();
  };

  (function step(now){
    const dt = now - last; last = now;
    if (playing && i < frames.length) {
      seekTo(rate === 0 ? span : clock + dt*rate);
      if (i >= frames.length) { playing = false; $('rpPlay').innerHTML = '&#9654;'; fit(); }
    }
    requestAnimationFrame(step);
  })(performance.now());

  $('rpPlay').onclick = () => {
    if (i >= frames.length) reset();
    playing = !playing;
    $('rpPlay').innerHTML = playing ? '&#10074;&#10074;' : '&#9654;';
  };
  $('rpBack').onclick = () => { reset(); playing = true; $('rpPlay').innerHTML = '&#10074;&#10074;'; };
  $('rpSeek').oninput = (e) => { playing = false; $('rpPlay').innerHTML = '&#9654;';
    seekTo((e.target.value/1000)*span); };
  $('rpSpeed').onchange = (e) => { rate = Number(e.target.value); };
  $('rpPlay').innerHTML = '&#10074;&#10074;';
  reset();
})();
</script>`;

  // A shared file must never reach for a server: pin the page into snapshot
  // mode so it never opens an EventSource, and let the driver feed apply().
  const pinned = html.replace(
    "const SNAPSHOT=new URLSearchParams(location.search).has('snapshot');",
    'const SNAPSHOT=true;  // exported file has no server to stream from',
  );
  if (pinned === html) throw new Error('export: could not pin snapshot mode');
  return pinned.replace('</body>', driver + '</body>');
}
