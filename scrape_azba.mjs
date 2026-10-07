// ─────────────────────────────────────────────────────────────────────────────
// ParaXC — récupération des activations RTBA / AZBA
//
// Ouvre la carte AZBA officielle du SIA dans un vrai navigateur (Chromium sans
// fenêtre), exactement comme un visiteur. La carte télécharge elle-même ses
// données (zones RTBA + créneaux d'activation) ; le script les lit au passage,
// puis les envoie au serveur ParaXC (action rtba_upload de ParaXC_backend.php).
//
// Variables d'environnement :
//   PARAXC_UPLOAD_URL  ex. https://www.monsite.fr/ParaXC_backend.php?action=rtba_upload
//   PARAXC_UPLOAD_KEY  clé secrète, identique à RTBA_UPLOAD_KEY dans ParaXC_backend.php
//   SIA_PAGE_URL       (facultatif) page à ouvrir — par défaut la carte AZBA du SIA
//   DRY_RUN=1          (facultatif) n'envoie rien, écrit seulement rtba.json
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PAGE_URL   = process.env.SIA_PAGE_URL || 'https://www.sia.aviation-civile.gouv.fr/azbaEx/?lang=fr';
const UPLOAD_URL = process.env.PARAXC_UPLOAD_URL || '';
const UPLOAD_KEY = process.env.PARAXC_UPLOAD_KEY || '';
const DRY_RUN    = process.env.DRY_RUN === '1';
const WAIT_MS    = 180_000; // délai maximal pour que la carte charge ses données (3 min)

if (!DRY_RUN && (!UPLOAD_URL || !UPLOAD_KEY)) {
  console.error('❌ PARAXC_UPLOAD_URL et PARAXC_UPLOAD_KEY doivent être définis (secrets GitHub).');
  process.exit(1);
}

const zones = new Map();   // @id → zone (fusion si la carte fait plusieurs requêtes)
let responses = 0;
let badBodies = 0;   // réponses r_t_b_as au contenu inattendu

// CHROMIUM_PATH (facultatif) : utiliser un Chromium déjà installé
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--disable-blink-features=AutomationControlled'],
});
// Signature de navigateur ordinaire : sans fenêtre, Chromium se présente
// sinon comme « HeadlessChrome », ce que certains sites refusent.
const chromeVersion = browser.version().split('.')[0];
const context = await browser.newContext({
  userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion}.0.0.0 Safari/537.36`,
  locale: 'fr-FR',
  timezoneId: 'Europe/Paris',
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

// Journal des échanges de la carte avec le SIA (pour le diagnostic)
const apiLog = [];
const t0 = Date.now();
const sec = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5);
page.on('response', (res) => {
  const u = res.url();
  if (!/sia-france\.fr|aviation-civile\.gouv\.fr\/(api|azbaEx\/api)/.test(u)) return;
  const line = `${sec()}s ${res.status()} ${res.request().method()} ${u.split('?')[0].replace(/^https?:\/\/[^/]+/, '')}`;
  apiLog.push(line);
  console.log('   ' + line);
});
// Fin réelle de chaque téléchargement (le statut 200 arrive avant le contenu)
page.on('requestfinished', async (req) => {
  const u = req.url();
  if (!/sia-france\.fr|aviation-civile\.gouv\.fr\/(api|azbaEx\/api)/.test(u)) return;
  let size = '?';
  try { size = (await req.sizes()).responseBodySize; } catch {}
  const line = `${sec()}s TERMINÉ ${u.split('?')[0].replace(/^https?:\/\/[^/]+/, '')} (${size} octets)`;
  apiLog.push(line);
  console.log('   ' + line);
});
page.on('requestfailed', (req) => {
  const line = `${sec()}s ÉCHEC ${req.method()} ${req.url().split('?')[0]} (${req.failure()?.errorText})`;
  apiLog.push(line);
  console.log('   ' + line);
});
page.on('console', (msg) => { if (msg.type() === 'error') apiLog.push(`${sec()}s console: ${msg.text().slice(0, 200)}`); });

// Lecture des données reçues par la carte (zones RTBA + créneaux)
page.on('response', async (res) => {
  if (!/\/api\/v\d+\/r_t_b_as(\?|$)/.test(res.url()) || !res.ok()) return;
  let text = '';
  try {
    // Délai maximal : si le contenu n'arrive jamais, on le note au lieu d'attendre indéfiniment
    text = await Promise.race([
      res.text(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('contenu jamais reçu en entier (90 s)')), 90_000)),
    ]);
    const data = JSON.parse(text);
    const members = data['hydra:member'] || data.member || [];
    members.forEach((z) => zones.set(z['@id'] || `${z.codeId}-${z.name}`, z));
    responses++;
    console.log(`📥 ${members.length} zones reçues (${res.url().split('?')[0]})`);
  } catch (e) {
    // Contenu inattendu : on le garde pour le diagnostic
    const n = ++badBodies;
    apiLog.push(`${sec()}s réponse r_t_b_as illisible (${e.message}) → debug/rtba_reponse_${n}.txt`);
    console.warn(`⚠ Réponse r_t_b_as illisible : ${e.message} (début : ${JSON.stringify(text.slice(0, 120))})`);
    try {
      mkdirSync('debug', { recursive: true });
      writeFileSync(`debug/rtba_reponse_${n}.txt`,
        `URL : ${res.url()}\nStatut : ${res.status()}\n\nEn-têtes :\n` +
        Object.entries(await res.allHeaders()).map(([k, v]) => `${k}: ${v}`).join('\n') +
        `\n\nLongueur du contenu : ${text.length}\n\nDébut du contenu :\n${text.slice(0, 4000)}`);
    } catch {}
  }
});

let exitCode = 0;
try {
  console.log(`🌐 Ouverture de ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });

  // Attendre que la carte ait reçu ses données, puis un court délai pour
  // laisser arriver d'éventuelles requêtes complémentaires.
  let lastLog = 0;
  while (!responses && Date.now() - t0 < WAIT_MS) {
    await page.waitForTimeout(500);
    // Réponses reçues mais illisibles : inutile d'attendre les 3 minutes
    if (badBodies && Date.now() - t0 > 100_000) break;
    if (Date.now() - lastLog > 30_000) { lastLog = Date.now(); console.log(`⏳ ${sec()}s — en attente des zones RTBA…`); }
  }
  if (responses) await page.waitForTimeout(3000);

  if (!zones.size) throw new Error(badBodies
    ? `les réponses RTBA du SIA ne sont pas des données lisibles (${badBodies} réponse(s) enregistrée(s) dans debug-sia)`
    : "la carte du SIA n'a renvoyé aucune zone RTBA");

  const payload = {
    'hydra:member': [...zones.values()],
    fetchedAt: new Date().toISOString(),
    source: PAGE_URL,
  };
  const nSlots = payload['hydra:member'].reduce((n, z) => n + (z.timeSlots?.length || 0), 0);
  console.log(`✅ ${zones.size} zones, ${nSlots} créneaux d'activation`);

  if (DRY_RUN) {
    writeFileSync('rtba.json', JSON.stringify(payload));
    console.log('💾 rtba.json écrit (DRY_RUN, rien envoyé)');
  } else {
    const r = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ParaXC-Key': UPLOAD_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`envoi au serveur ParaXC refusé : HTTP ${r.status} ${txt.slice(0, 300)}`);
    console.log(`📤 Envoyé au serveur ParaXC : ${txt.slice(0, 200)}`);
  }
} catch (e) {
  console.error('❌ Échec :', e.message);
  exitCode = 1;
  // Capture d'écran pour comprendre ce que la page affichait
  try {
    mkdirSync('debug', { recursive: true });
    await page.screenshot({ path: 'debug/page.png', fullPage: true });
    writeFileSync('debug/page.html', await page.content());
    writeFileSync('debug/requetes.txt', apiLog.join('\n'));
  } catch {}
} finally {
  await browser.close();
}
process.exit(exitCode);
