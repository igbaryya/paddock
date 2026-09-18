/**
 * The download page reads published GitHub releases at load. Drafts never appear: the public API
 * does not return them, which is the same gate the installed app's updater uses.
 */
const REPO = 'igbaryya/paddock';
const RELEASES = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases`;

const KINDS = [
  { id: 'mac-arm64', label: 'macOS', detail: 'Apple silicon' },
  { id: 'mac-x64', label: 'macOS', detail: 'Intel' },
  { id: 'win', label: 'Windows', detail: 'x64 & ARM64' },
];

function classify(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.yml') || n.endsWith('.blockmap') || n.endsWith('.zip')) return null;
  if (n.endsWith('.exe')) return 'win';
  if (n.endsWith('.dmg')) {
    if (n.includes('arm64')) return 'mac-arm64';
    return 'mac-x64';
  }
  return null;
}

function assetsByKind(assets) {
  const map = {};
  for (const asset of assets) {
    const kind = classify(asset.name);
    if (kind) map[kind] = asset;
  }
  return map;
}

function detectKind() {
  const platform = navigator.userAgentData?.platform || navigator.platform || '';
  const ua = navigator.userAgent;
  if (/Win/i.test(platform) || /Windows NT/i.test(ua)) return 'win';
  // Apple silicon still often reports MacIntel in the UA; ARM is the default Mac in 2026.
  if (/Mac/i.test(platform) || /Mac OS/i.test(ua)) return 'mac-arm64';
  return 'mac-arm64';
}

function bytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '';
  const mb = n / (1024 * 1024);
  return mb >= 10 ? `${Math.round(mb)} MB` : `${mb.toFixed(1)} MB`;
}

function versionOf(release) {
  return release.tag_name.replace(/^v/, '');
}

function formatDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('"', '&quot;');
}

function el(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content;
}

function downloadLink(asset, className, label) {
  if (!asset) return '';
  const size = bytes(asset.size);
  return `<a class="${className}" href="${escapeHtml(asset.browser_download_url)}">${label}${
    size ? ` · ${size}` : ''
  }</a>`;
}

function renderLatest(release, preferred) {
  const root = document.getElementById('latest');
  const kind = KINDS.find((k) => k.id === preferred) || KINDS[0];
  const asset = assetsByKind(release.assets)[kind.id];
  const version = versionOf(release);
  const cta = asset
    ? downloadLink(asset, 'btn primary', `Download for ${kind.label} (${kind.detail})`)
    : `<a class="btn primary" href="${escapeHtml(release.html_url)}">View ${escapeHtml(version)} on GitHub</a>`;

  root.replaceChildren(
    el(`
      <div class="latest-row">
        <span class="version-pill"><span class="dot"></span>v${escapeHtml(version)}</span>
        ${cta}
      </div>
      <p class="hint">${escapeHtml(formatDate(release.published_at))} · other platforms below</p>
    `),
  );
}

function renderPlatforms(release) {
  const root = document.getElementById('platforms');
  const map = assetsByKind(release.assets);
  const cards = KINDS.map((kind) => {
    const asset = map[kind.id];
    const action = asset
      ? downloadLink(asset, 'btn', 'Download')
      : `<span class="meta">Not in this release</span>`;
    return `
      <article class="card">
        <h3>${kind.label}</h3>
        <p class="muted">${kind.detail}</p>
        ${asset ? `<p class="meta">${escapeHtml(asset.name)}</p>` : ''}
        ${action}
      </article>
    `;
  }).join('');
  root.replaceChildren(el(cards));
}

function renderHistory(releases) {
  const root = document.getElementById('history');
  const rows = releases
    .map((release) => {
      const map = assetsByKind(release.assets);
      const links = KINDS.map((kind) => {
        const asset = map[kind.id];
        if (!asset) return '';
        return `<a href="${escapeHtml(asset.browser_download_url)}">${kind.detail}</a>`;
      }).join('');
      return `
        <tr>
          <td class="ver"><a href="${escapeHtml(release.html_url)}">v${escapeHtml(versionOf(release))}</a></td>
          <td class="date">${escapeHtml(formatDate(release.published_at))}</td>
          <td><span class="links">${links || `<a href="${escapeHtml(release.html_url)}">GitHub</a>`}</span></td>
        </tr>
      `;
    })
    .join('');

  root.replaceChildren(
    el(`
      <table>
        <thead>
          <tr>
            <th>Version</th>
            <th class="skip">Date</th>
            <th>Installers</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `),
  );
}

function empty(message) {
  document.getElementById('latest').replaceChildren(
    el(`<p class="muted">${message} <a href="${RELEASES_PAGE}">GitHub releases</a></p>`),
  );
  document.getElementById('platforms').replaceChildren();
  document.getElementById('history').replaceChildren(el(`<p class="empty">${message}</p>`));
}

async function main() {
  try {
    const res = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub ${res.status}`);
    const releases = (await res.json()).filter((r) => !r.draft && !r.prerelease);
    if (!releases.length) {
      empty('No published release yet.');
      return;
    }
    const latest = releases[0];
    renderLatest(latest, detectKind());
    renderPlatforms(latest);
    renderHistory(releases);
  } catch (err) {
    empty('Could not load versions.');
    console.error(err);
  }
}

main();
