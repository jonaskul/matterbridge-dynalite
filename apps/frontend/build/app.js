// The plugin's own settings page: served by Matterbridge at
// /plugins/matterbridge-dynalite/ and shown in its dialog (or a tab of its own).
// It reads and saves the gateways through the plugin's API (platform.onFetch),
// tries a gateway's settings before they are saved, and offers the areas and
// channels heard on the bus, to add with a click. Plain JavaScript, no build.

const api = (path, init) =>
  fetch(`api/${path}`, { headers: { 'Content-Type': 'application/json' }, ...init }).then(async (r) => {
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `${r.status} ${r.statusText}`);
    return r.json();
  });

let gateways = [];
let saved = '[]';
let seen = [];
const tests = new Map(); // gateway index → result, or 'busy'
const openMore = new Set(); // gateways whose "More gateway settings" is open

// -- look: Matterbridge's colours when inside its dialog -----------------------

function takeParentColours() {
  try {
    const parent = window.parent !== window ? window.parent.document : null;
    if (!parent) return;
    const css = getComputedStyle(parent.body);
    // Not its border colour: in its dark theme that is the background's own.
    const names = ['--primary-color', '--main-bg-color', '--div-bg-color', '--main-text-color', '--main-grey-color'];
    let any = false;
    for (const n of names) {
      const v = css.getPropertyValue(n).trim();
      if (v) {
        document.documentElement.style.setProperty(n, v);
        any = true;
      }
    }
    if (any) document.documentElement.setAttribute('data-from-parent', '');
  } catch {
    // another origin: keep our own colours
  }
}

// -- small DOM helpers ------------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

const num = (v) => (v === '' || v === null || v === undefined || Number.isNaN(Number(v)) ? undefined : Number(v));

function field(label, input, hint) {
  return h('label', { class: 'field' }, label, input, hint ? h('span', { class: 'hint' }, hint) : null);
}

function text(obj, key, attrs = {}) {
  return h('input', { value: obj[key] ?? '', ...attrs, oninput: (e) => set(obj, key, e.target.value.trim() || undefined) });
}

function number(obj, key, attrs = {}) {
  return h('input', { type: 'number', inputmode: 'numeric', value: obj[key] ?? '', ...attrs, oninput: (e) => set(obj, key, num(e.target.value)) });
}

function check(obj, key, label, fallback = false) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: obj[key] ?? fallback, onchange: (e) => set(obj, key, e.target.checked) }), label);
}

function set(obj, key, value) {
  if (value === undefined) delete obj[key];
  else obj[key] = value;
  changed();
}

// -- state ------------------------------------------------------------------------

function changed() {
  const dirty = JSON.stringify(gateways) !== saved;
  document.getElementById('save').disabled = !dirty;
  status(dirty ? 'Unsaved changes.' : '');
}

function status(message, cls = 'muted') {
  const el = document.getElementById('status');
  el.textContent = message;
  el.className = cls;
}

async function load() {
  const { gateways: g, problems } = await api('config');
  gateways = JSON.parse(JSON.stringify(g ?? []));
  saved = JSON.stringify(gateways);
  render(problems ?? []);
  changed();
}

async function save() {
  const button = document.getElementById('save');
  button.disabled = true;
  status('Saving …');
  try {
    const { saved: ok, problems } = await api('config', { method: 'PUT', body: JSON.stringify({ gateways }) });
    if (!ok) throw new Error((problems ?? []).join(' '));
    saved = JSON.stringify(gateways);
    render(problems ?? []);
    status('Saved. Restart Matterbridge to apply the new settings.', 'ok');
  } catch (err) {
    status(`Not saved: ${err.message}`, 'bad');
    button.disabled = false;
  }
}

async function refreshSeen() {
  try {
    seen = await api('seen');
  } catch {
    seen = [];
  }
  for (const [i, gw] of gateways.entries()) {
    const box = document.getElementById(`seen-${i}`);
    if (box) box.replaceWith(seenPanel(gw, i));
  }
}

// -- rendering --------------------------------------------------------------------

function render(problems = []) {
  const app = document.getElementById('app');
  const parts = [
    problems.length ? h('ul', { class: 'problems' }, problems.map((p) => h('li', {}, p))) : null,
    gateways.length
      ? gateways.map((gw, i) => gatewayCard(gw, i))
      : h('div', { class: 'card' }, h('h2', {}, 'No gateway yet'), h('p', { class: 'muted' }, 'Add your Dynalite Ethernet gateway (PDEG, DDNG and similar) to begin.')),
  ];
  app.replaceChildren(...parts.flat().filter(Boolean));
}

function gatewayCard(gw, i) {
  gw.areas ??= [];
  const result = tests.get(i);
  return h(
    'section',
    { class: 'card' },
    h(
      'div',
      { class: 'card-head' },
      h('h2', {}, gw.name || `Gateway ${i + 1}`),
      h('button', { type: 'button', onclick: () => test(i), disabled: result === 'busy' || !gw.host }, result === 'busy' ? 'Testing …' : 'Test connection'),
      h('button', {
        type: 'button',
        class: 'danger',
        onclick: () => {
          if (!confirm(`Remove gateway ${gw.name || i + 1} and its areas?`)) return;
          gateways.splice(i, 1);
          tests.clear();
          render();
          changed();
        },
      }, 'Remove'),
    ),
    h(
      'div',
      { class: 'grid' },
      field('Name', text(gw, 'name', { placeholder: 'Home', required: true }), 'Part of every device\'s identity: keep it once set.'),
      field('Address', text(gw, 'host', { placeholder: '192.168.1.50', required: true }), 'The gateway\'s web pages: an IP or host name.'),
      field('DyNet TCP port', number(gw, 'dynetPort', { min: 1, max: 65535, placeholder: 'e.g. 50000' }), 'For live updates. Empty: polled only.'),
    ),
    result && result !== 'busy' ? testResult(result) : null,
    h(
      'details',
      { open: openMore.has(i), ontoggle: (e) => (e.target.open ? openMore.add(i) : openMore.delete(i)) },
      h('summary', {}, 'More gateway settings'),
      h(
        'div',
        { class: 'grid' },
        field('Read every area every … minutes', number(gw, 'pollMinutes', { min: 1, max: 1440, placeholder: gw.dynetPort ? '60' : '5' }), 'A check with live updates; the only source without.'),
        field('Fade for commands, seconds', number(gw, 'fadeSeconds', { min: 0, max: 600, step: 0.1, placeholder: '2' })),
        field('Username', text(gw, 'username', { autocomplete: 'off' }), 'Only if the gateway asks for one.'),
        field('Password', h('input', { type: 'password', value: gw.password ?? '', autocomplete: 'new-password', oninput: (e) => set(gw, 'password', e.target.value || undefined) })),
      ),
      h('div', { class: 'inline', style: 'margin-top:10px' }, check(gw, 'https', 'HTTPS'), check(gw, 'allowSelfSigned', 'Accept its self-signed certificate')),
    ),
    areasSection(gw, i),
    seenPanel(gw, i),
  );
}

function testResult(r) {
  const line = (label, x) => h('div', { class: x.ok ? 'ok' : 'bad' }, `${x.ok ? '✓' : '✗'} ${label}: ${x.message}`);
  return h('div', { class: 'result' }, line('Web pages', r.http), r.dynet ? line('DyNet port', r.dynet) : h('div', { class: 'muted' }, 'No DyNet port set: live updates are off.'));
}

async function test(i) {
  tests.set(i, 'busy');
  render();
  try {
    tests.set(i, await api('test', { method: 'POST', body: JSON.stringify(gateways[i]) }));
  } catch (err) {
    tests.set(i, { http: { ok: false, message: err.message } });
  }
  render();
}

function areasSection(gw, gi) {
  const sorted = [...gw.areas].sort((a, b) => (a.area ?? 1e9) - (b.area ?? 1e9));
  return h(
    'div',
    { class: 'section' },
    h(
      'div',
      { class: 'section-head' },
      h('h3', {}, `Areas (${gw.areas.length})`),
      h('button', { type: 'button', class: 'small', onclick: () => addArea(gw, { type: 'light' }) }, '+ Light'),
      h('button', { type: 'button', class: 'small', onclick: () => addArea(gw, { type: 'thermostat' }) }, '+ Thermostat'),
    ),
    gw.areas.length ? sorted.map((a) => areaRow(gw, a)) : h('p', { class: 'muted' }, 'None yet. Add one, or pick from what the bus has said below.'),
  );
}

function addArea(gw, area) {
  gw.areas.push(area);
  render();
  changed();
}

function areaRow(gw, a) {
  a.type ??= 'light';
  const what =
    a.type === 'thermostat'
      ? h(
          'div',
          { class: 'what' },
          h('div', { class: 'inline' }, 'Setpoints from', number(a, 'minSetpoint', { class: 'num', step: 0.5, placeholder: '5' }), 'to', number(a, 'maxSetpoint', { class: 'num', step: 0.5, placeholder: '30' }), '°C'),
        )
      : lightDetails(a);
  return h(
    'div',
    { class: 'area' },
    field('Area', number(a, 'area', { min: 1, max: 65535, required: true })),
    field('Name', text(a, 'name', { placeholder: 'Kitchen', required: true })),
    h(
      'div',
      { class: 'type' },
      field(
        'Type',
        h(
          'select',
          {
            onchange: (e) => {
              a.type = e.target.value;
              render();
              changed();
            },
          },
          h('option', { value: 'light', selected: a.type !== 'thermostat' }, 'Light'),
          h('option', { value: 'thermostat', selected: a.type === 'thermostat' }, 'Thermostat'),
        ),
      ),
    ),
    what,
    h('button', {
      type: 'button',
      class: 'icon danger del',
      title: 'Remove the area',
      'aria-label': 'Remove the area',
      onclick: () => {
        gw.areas.splice(gw.areas.indexOf(a), 1);
        render();
        changed();
      },
    }, '✕'),
  );
}

function lightDetails(a) {
  a.channels ??= [];
  const add = h('input', { class: 'num', type: 'number', min: 1, max: 255, placeholder: 'ch' });
  const addChannel = () => {
    const c = num(add.value);
    if (!c || a.channels.some((x) => x.channel === c)) return;
    a.channels.push({ channel: c });
    a.channels.sort((x, y) => x.channel - y.channel);
    render();
    changed();
  };
  add.addEventListener('keydown', (e) => e.key === 'Enter' && addChannel());
  return h(
    'div',
    { class: 'what' },
    a.channels.length
      ? h(
          'div',
          { class: 'chips' },
          a.channels.map((c) =>
            h(
              'span',
              { class: 'chip' },
              h('span', { class: 'no' }, `ch ${c.channel}`),
              h('input', { value: c.name ?? '', placeholder: `${a.name || 'Area'} ${c.channel}`, 'aria-label': `Name of channel ${c.channel}`, oninput: (e) => set(c, 'name', e.target.value.trim() || undefined) }),
              h('label', { class: 'check', title: 'Off for a relay that only switches' }, h('input', { type: 'checkbox', checked: c.dimmable !== false, onchange: (e) => set(c, 'dimmable', e.target.checked ? undefined : false) }), 'dim'),
              h('button', {
                type: 'button',
                title: `Remove channel ${c.channel}`,
                onclick: () => {
                  a.channels.splice(a.channels.indexOf(c), 1);
                  render();
                  changed();
                },
              }, '✕'),
            ),
          ),
        )
      : h(
          'div',
          { class: 'inline' },
          'One light, switched by presets: on',
          number(a, 'onPreset', { class: 'num', min: 1, placeholder: '1' }),
          'off',
          number(a, 'offPreset', { class: 'num', min: 1, placeholder: '4' }),
        ),
    h('div', { class: 'inline' }, add, h('button', { type: 'button', class: 'small', onclick: addChannel }, '+ Channel'), h('span', { class: 'hint' }, a.channels.length ? 'Each channel is its own light.' : 'Or add channels: each its own light.')),
  );
}

function seenPanel(gw, gi) {
  const mine = seen.find((s) => s.gateway === gw.name);
  const box = h('div', { class: 'section', id: `seen-${gi}` });
  const head = h('div', { class: 'section-head' }, h('h3', {}, 'Heard on the bus'));
  if (!mine) {
    box.append(head, h('p', { class: 'muted' }, gw.dynetPort ? 'Nothing yet. Save and restart with a DyNet port set, then use a panel or a scene: what the bus says shows here.' : 'Set a DyNet port to see the areas and channels the bus talks about.'));
    return box;
  }
  if (mine.live !== 'connected') head.append(h('span', { class: 'warn' }, mine.live === 'off' ? 'live updates off' : 'not connected'));
  box.append(head);
  if (!mine.areas.length) {
    box.append(h('p', { class: 'muted' }, 'Nothing heard yet. Press a panel or choose a scene.'));
    return box;
  }
  const rows = mine.areas.map((s) => {
    const known = gw.areas.find((a) => a.area === s.area);
    const bits = [
      s.thermostat ? `thermostat${s.temperature !== undefined ? `, ${s.temperature.toFixed(1)} °C` : ''}` : null,
      s.channels.length ? `channels ${s.channels.join(', ')}` : null,
      s.presets.length ? `presets ${s.presets.join(', ')}` : null,
    ].filter(Boolean);
    const acts = known
      ? [h('span', { class: 'tag' }, 'added'), ...addMissingChannels(known, s)]
      : [
          s.thermostat ? h('button', { type: 'button', class: 'small', onclick: () => addArea(gw, { area: s.area, name: `Area ${s.area}`, type: 'thermostat' }) }, 'Add as thermostat') : null,
          // A thermostat that told no channel is no light.
          s.thermostat && !s.channels.length
            ? null
            : h('button', {
                type: 'button',
                class: 'small',
                onclick: () => addArea(gw, { area: s.area, name: `Area ${s.area}`, type: 'light', channels: s.channels.map((channel) => ({ channel })) }),
              }, s.channels.length ? `Add as light (${s.channels.length} ch)` : 'Add as light'),
        ];
    return h('div', { class: 'seen-row' }, h('strong', {}, `Area ${s.area}`), h('span', { class: 'muted' }, bits.join(' · ') || `${s.count} packet(s)`), h('div', { class: 'acts' }, acts));
  });
  box.append(h('div', { class: 'seen' }, rows));
  return box;
}

function addMissingChannels(area, s) {
  if (area.type !== 'light') return [];
  const have = new Set((area.channels ?? []).map((c) => c.channel));
  const missing = s.channels.filter((c) => !have.has(c));
  if (!missing.length) return [];
  return [
    h('button', {
      type: 'button',
      class: 'small',
      onclick: () => {
        area.channels = [...(area.channels ?? []), ...missing.map((channel) => ({ channel }))].sort((x, y) => x.channel - y.channel);
        render();
        changed();
      },
    }, `+ ch ${missing.join(', ')}`),
  ];
}

// -- start ------------------------------------------------------------------------

takeParentColours();
document.getElementById('save').addEventListener('click', save);
document.getElementById('add-gateway').addEventListener('click', () => {
  gateways.push({ name: gateways.length ? `Gateway ${gateways.length + 1}` : 'Home', host: '', areas: [] });
  render();
  changed();
});
window.addEventListener('beforeunload', (e) => {
  if (JSON.stringify(gateways) !== saved) e.preventDefault();
});
load()
  .then(refreshSeen)
  .catch((err) => {
    document.getElementById('app').replaceChildren(h('p', { class: 'bad' }, `Could not read the settings: ${err.message}. Is the plugin running?`));
  });
setInterval(refreshSeen, 5000);
