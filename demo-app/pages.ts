/**
 * Demo application pages. Each "bug" page plants specific, documented defects; /legit contains correct UI that
 * *looks* risky (tooltips, dropdowns, modals, badges, ellipsis, skip links) and must produce ZERO defects.
 * The catalogue at the bottom is the ground truth used by the end-to-end tests.
 */

const CSS = `
*{box-sizing:border-box}
body{font-family:system-ui,Arial,sans-serif;margin:0;color:#1a1a1a;background:#fff;line-height:1.5}
header.site{background:#0b3d91;padding:12px 24px}
header.site a{color:#fff;margin-right:16px;display:inline-block;padding:8px 4px;min-height:32px}
main{padding:24px;max-width:1100px;margin:0 auto;position:relative}
h1{font-size:28px;margin:0 0 12px}h2{font-size:20px}
button,.btn{font-size:16px;padding:10px 18px;min-height:40px;border:1px solid #0b3d91;background:#0b3d91;color:#fff;border-radius:4px;cursor:pointer}
a{color:#0b3d91}
label{display:block;margin-top:8px}
input,select,textarea{font-size:16px;padding:8px;min-height:40px;border:1px solid #555;border-radius:4px}
.card{border:1px solid #ccc;padding:16px;margin:16px 0;border-radius:6px}
`;

export function layout(title: string, body: string, extraHead = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - Demo App</title><style>${CSS}</style>${extraHead}</head><body>
<header class="site"><nav aria-label="Primary"><a href="/">Home</a><a href="/overlap">Overlap</a><a href="/clipping">Clipping</a><a href="/overflow">Overflow</a><a href="/links">Links</a><a href="/errors">Errors</a><a href="/forms">Forms</a><a href="/responsive">Responsive</a><a href="/modal">Modal</a><a href="/dynamic">Dynamic</a><a href="/slow">Slow</a><a href="/legit">Legit</a><a href="/danger">Danger</a><a href="/account">Account</a></nav></header>
<main>${body}</main></body></html>`;
}

export const PAGES: Record<string, string> = {
  '/': layout('Home', `<h1>Demo Application</h1><p>An intentionally broken app for validating the QA platform.</p>
<ul><li><a href="/overlap">Overlapping content</a></li><li><a href="/clipping">Clipped text</a></li><li><a href="/overflow">Overflow and small targets</a></li><li><a href="/links">Broken links</a></li><li><a href="/errors">Console and network errors</a></li><li><a href="/forms">Forms</a></li><li><a href="/responsive">Responsive issues</a></li><li><a href="/modal">Modal</a></li><li><a href="/dynamic">Dynamic content</a></li><li><a href="/slow">Slow API</a></li><li><a href="/a11y">Accessibility problems</a></li><li><a href="/legit">Legitimate UI (no defects expected)</a></li><li><a href="/danger">Dangerous actions (must never be clicked)</a></li><li><a href="/account">Account (needs auth)</a></li></ul>`),

  '/overlap': layout('Overlap', `<h1>Overlap</h1><div style="position:relative;height:260px">
<div id="ov-text-a" style="position:absolute;top:20px;left:10px;width:320px;font-size:20px">Overlapping text block number one</div>
<div id="ov-text-b" style="position:absolute;top:28px;left:40px;width:320px;font-size:20px">Overlapping text block number two</div>
<button id="ov-btn-a" style="position:absolute;top:120px;left:10px;width:180px">Primary action</button>
<button id="ov-btn-b" style="position:absolute;top:128px;left:90px;width:180px">Secondary action</button></div>`),

  '/clipping': layout('Clipping', `<h1>Clipping</h1>
<div id="clipped" style="width:120px;height:24px;overflow:hidden;white-space:nowrap;border:1px solid #999">This label is far too long and is silently clipped</div>
<div id="clipped-vertical" style="width:200px;height:20px;overflow:hidden;border:1px solid #999">Line one of the text<br>Line two of the text is hidden<br>Line three is hidden too</div>`),

  '/overflow': layout('Overflow', `<h1>Overflow</h1>
<div id="wide" style="width:2200px;height:40px;background:#e8eefc">This element is wider than any viewport</div>
<div class="card" id="container" style="width:220px"><div id="inner" style="width:480px;background:#ffe9c4">Inner content wider than its card</div></div>
<p><a id="tiny-link" href="/" style="display:inline-block;width:12px;height:12px;background:#c00" aria-label="Tiny link"></a>
<button id="tiny-btn" style="width:16px;height:16px;min-height:0;padding:0" aria-label="Tiny button"></button></p>`),

  '/links': layout('Links', `<h1>Links</h1><ul>
<li><a id="ok-link" href="/legit">A working link</a></li>
<li><a id="broken-404" href="/does-not-exist">Broken link (404)</a></li>
<li><a id="broken-500" href="/error-500">Server error page (500)</a></li>
<li><a id="placeholder" href="#">Placeholder link</a></li></ul>`),

  '/errors': layout('Errors', `<h1>Errors</h1>
<button id="log-error">Trigger console error</button> <button id="throw-error">Throw exception</button> <button id="call-fail">Call failing API</button>
<img src="/img/missing.png" alt="Missing illustration" width="80" height="60">
<script>
fetch('/api/fail').catch(()=>{});
document.getElementById('log-error').addEventListener('click',()=>console.error('Demo console error: something failed'));
document.getElementById('throw-error').addEventListener('click',()=>setTimeout(()=>{throw new Error('Demo uncaught exception')},0));
document.getElementById('call-fail').addEventListener('click',()=>fetch('/api/fail').catch(()=>{}));
</script>`),

  '/forms': layout('Forms', `<h1>Forms</h1>
<form id="signup" action="/api/subscribe" method="post" novalidate aria-label="Newsletter signup">
<input id="signup-email" name="email" type="email" required placeholder="Email address">
<label for="signup-name">Name</label><input id="signup-name" name="name" type="text">
<label for="signup-age">Age</label><input id="signup-age" name="age" type="number" min="18" max="120" required>
<button type="submit">Subscribe</button></form>
<p id="signup-msg" role="status"></p>
<script>document.getElementById('signup').addEventListener('submit',(e)=>{e.preventDefault();fetch('/api/subscribe',{method:'POST',body:new FormData(e.target)}).catch(()=>{});document.getElementById('signup-msg').textContent='Thanks for subscribing!'});</script>`),

  '/responsive': layout('Responsive', `<h1>Responsive</h1>
<div id="nowrap-nav" style="white-space:nowrap;background:#eee;padding:8px"><a href="/">Alpha section</a> <a href="/">Beta section</a> <a href="/">Gamma section</a> <a href="/">Delta section</a> <a href="/">Epsilon section</a> <a href="/">Zeta section</a> <a href="/">Eta section</a></div>
<table id="wide-table" style="width:900px;border-collapse:collapse" border="1"><caption>Quarterly figures</caption><thead><tr><th>Region</th><th>Q1</th><th>Q2</th><th>Q3</th><th>Q4</th><th>Total</th><th>Notes</th></tr></thead>
<tbody><tr><td>North</td><td>10</td><td>20</td><td>30</td><td>40</td><td>100</td><td>On track</td></tr></tbody></table>
<img id="fixed-img" src="/img/banner.svg" width="1200" height="120" alt="Wide banner">`),

  '/modal': layout('Modal', `<h1>Modal</h1><button id="open-modal" aria-haspopup="dialog">Open settings</button>
<div id="backdrop" hidden style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:50"></div>
<div id="dlg" role="dialog" aria-modal="true" aria-labelledby="dlg-title" hidden style="position:fixed;top:20%;left:50%;transform:translateX(-50%);background:#fff;padding:24px;border-radius:8px;z-index:60;width:min(420px,90vw)">
<h2 id="dlg-title">Settings</h2><p>Adjust your preferences.</p><button id="close-modal">Close</button></div>
<script>const d=document.getElementById('dlg'),b=document.getElementById('backdrop');
document.getElementById('open-modal').addEventListener('click',()=>{d.hidden=false;b.hidden=false});
document.getElementById('close-modal').addEventListener('click',()=>{d.hidden=true;b.hidden=true});</script>`),

  '/dynamic': layout('Dynamic', `<h1>Dynamic content</h1>
<p>Rendered at: <span id="clock" data-dynamic="true" style="display:inline-block;width:30ch;font-family:monospace"></span></p><p>Random: <span id="rand" data-dynamic="true" style="display:inline-block;width:30ch;font-family:monospace"></span></p>
<p>Stable text that never changes.</p>
<script>document.getElementById('clock').textContent=new Date().toISOString();document.getElementById('rand').textContent=Math.random().toString(36).slice(2);</script>`),

  '/slow': layout('Slow API', `<h1>Slow API</h1><p id="slow-out">Loading...</p>
<script>fetch('/api/slow').then(r=>r.json()).then(j=>{document.getElementById('slow-out').textContent='Loaded: '+j.value})</script>`),

  '/danger': layout('Danger zone', `<h1>Danger zone</h1><p>These controls must never be activated by the platform.</p>
<button id="delete-account" onclick="fetch('/api/delete-account',{method:'POST'})">Delete account</button>
<button id="buy-now" onclick="fetch('/api/purchase',{method:'POST'})">Buy now</button>
<form action="/api/delete-account" method="post" aria-label="Close account form"><label for="confirm">Type DELETE to confirm</label><input id="confirm" name="confirm"><button type="submit">Close account</button></form>
<p><a href="/api/delete-account-link">Delete everything (link)</a></p>`),

  '/account': layout('Account', `<h1>Account</h1><p id="who" role="status">Checking sign-in...</p>
<script>
const t=localStorage.getItem('token')||sessionStorage.getItem('token');
fetch('/api/me',{headers:t?{Authorization:'Bearer '+t}:{}}).then(async r=>{const j=await r.json().catch(()=>({}));
document.getElementById('who').textContent=r.ok?('Signed in as '+j.name):'Not signed in';});
</script>`),

  '/a11y': layout('Accessibility', `<style>#no-outline:focus{outline:none}#no-outline{padding:8px}</style><h1>Accessibility problems</h1>
<img id="no-alt" src="/img/banner.svg" width="300" height="30">
<p id="low-contrast" style="color:#b5b5b5;background:#fff">Pale grey text that is hard to read.</p>
<h4 id="skipped-heading">Heading level skipped</h4>
<p id="dup-a">First</p><p id="dup-a">Duplicate id</p>
<button id="no-name"><svg width="16" height="16" aria-hidden="true"><circle cx="8" cy="8" r="6"/></svg></button>
<div id="fake-btn" role="button" style="display:inline-block;padding:10px;border:1px solid #333" onclick="document.getElementById('fake-out').textContent='clicked'">Fake button (not focusable)</div>
<a id="no-outline" href="/legit">Link without focus indicator</a>
<p id="fake-out" role="status"></p>
<div role="banana" id="bad-role">Invalid role</div>`),

  '/error-500': '<!doctype html><html lang="en"><head><title>Server error</title></head><body><main><h1>Internal Server Error</h1></main></body></html>',

  '/legit': layout('Legit UI', `<a href="#content" style="position:absolute;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden">Skip to main content</a>
<h1 id="content">Legitimate UI patterns</h1>
<p>Everything on this page is correct. Any <em>defect</em> reported here is a false positive.</p>
<h2>Tooltip</h2>
<div style="position:relative;display:inline-block;margin:24px 0"><button id="has-tip" aria-describedby="tip1">Hover me</button>
<span id="tip1" role="tooltip" style="position:absolute;left:10px;top:34px;background:#222;color:#fff;padding:4px 8px;border-radius:4px;z-index:20;white-space:nowrap">Helpful tooltip text</span></div>
<p style="margin-top:0">Paragraph text sitting underneath the tooltip area.</p>
<h2>Dropdown</h2>
<div style="position:relative;display:inline-block"><button id="menu-btn" aria-haspopup="true" aria-expanded="true">Actions</button>
<ul id="menu" role="menu" style="position:absolute;left:0;top:44px;margin:0;padding:4px;list-style:none;background:#fff;border:1px solid #888;z-index:30;width:160px"><li role="none"><a role="menuitem" href="/legit" style="display:block;padding:10px">Rename</a></li><li role="none"><a role="menuitem" href="/legit" style="display:block;padding:10px">Share</a></li></ul></div>
<p style="margin-top:110px">Content that the open dropdown overlaps.</p>
<h2>Badge</h2>
<button id="inbox" style="position:relative">Inbox<span class="badge" aria-label="3 unread messages" style="position:absolute;top:-8px;right:-8px;min-width:18px;height:18px;border-radius:9px;background:#b00020;color:#fff;font-size:11px;text-align:center;line-height:18px">3</span></button>
<h2>Popover</h2>
<div style="position:relative;display:inline-block"><button id="pop-btn" aria-expanded="true" aria-controls="pop">Details</button>
<div id="pop" role="dialog" aria-label="Details popover" style="position:absolute;left:0;top:44px;width:220px;padding:12px;background:#fff;border:1px solid #888;z-index:25;box-shadow:0 2px 8px rgba(0,0,0,.3)">Popover content that floats above the page.</div></div>
<p style="margin-top:100px">Text below the popover.</p>
<h2>Intentional truncation</h2>
<div id="ellipsis" style="width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:1px solid #999" title="A deliberately truncated line of text">A deliberately truncated line of text</div>
<h2>Visually hidden text</h2>
<button id="icon-btn" aria-label="Search" style="width:44px;height:44px"><span class="sr" style="position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">Search</span>&#9906;</button>
<h2>Accessible form</h2>
<form id="contact" action="/api/contact" method="post" aria-label="Contact form">
<label for="c-email">Email</label><input id="c-email" name="email" type="email" required autocomplete="email">
<label for="c-msg">Message</label><textarea id="c-msg" name="msg" required minlength="5"></textarea>
<button type="submit">Send message</button></form>
<h2>Image</h2><img src="/img/banner.svg" width="300" height="30" alt="Decorative banner">
<p>Read the <a href="/links">links page</a> for more information about the demo.</p>
<div id="modal-open" role="dialog" aria-modal="true" aria-label="Cookie notice" style="position:fixed;bottom:12px;right:12px;width:260px;background:#fff;border:1px solid #444;padding:12px;z-index:40;box-shadow:0 2px 10px rgba(0,0,0,.35)">We use cookies. <button id="cookie-ok" style="margin-top:8px">Got it</button></div>`),
};

export const BANNER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="120" viewBox="0 0 1200 120"><rect width="1200" height="120" fill="#cfe0ff"/><text x="20" y="70" font-size="32" fill="#0b3d91">Banner</text></svg>';

/** Ground truth for tests: which rule families MUST fire on which page, and which pages must be clean. */
export const GROUND_TRUTH = {
  '/overlap': ['geometry.overlap'],
  '/clipping': ['geometry.text-clipping'],
  '/overflow': ['geometry.horizontal-overflow', 'geometry.container-overflow', 'geometry.small-target'],
  '/links': ['functional.link'],
  '/errors': ['network.failed-request', 'functional.button'],
  '/forms': ['functional.form'],
  '/responsive': ['responsive.table-overflow'],
  '/slow': ['network.slow-request'],
  '/a11y': ['a11y.image-alt', 'a11y.color-contrast', 'a11y.keyboard.unreachable'],
} as const;
export const CLEAN_PAGES = ['/legit'] as const;
