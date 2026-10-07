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
const WAIT_MS    = 60_000; // délai maximal pour que la carte charge ses données

if (!DRY_RUN && (!UPLOAD_URL || !UPLOAD_KEY)) {
  console.error('❌ PARAXC_UPLOAD_URL et PARAXC_UPLOAD_KEY doivent être définis (secrets GitHub).');
  process.exit(1);
}

const zones = new Map();   // @id → zone (fusion si la carte fait plusieurs requêtes)
let responses = 0;

// CHROMIUM_PATH (facultatif) : utiliser un Chromium déjà installé
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
const context = await browser.newContext({
  locale: 'fr-FR',
  timezoneId: 'Europe/Paris',
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();

// Lecture des données reçues par la carte (zones RTBA + créneaux)
page.on('response', async (res) => {
  if (!/\/api\/v\d+\/r_t_b_as(\?|$)/.test(res.url()) || !res.ok()) return;
  try {
    const data = await res.json();
    const members = data['hydra:member'] || data.member || [];
    members.forEach((z) => zones.set(z['@id'] || `${z.codeId}-${z.name}`, z));
    responses++;
    console.log(`📥 ${members.length} zones reçues (${res.url().split('?')[0]})`);
  } catch (e) {
    console.warn('Réponse illisible :', e.message);
  }
});

let exitCode = 0;
try {
  console.log(`🌐 Ouverture de ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: WAIT_MS });

  // Attendre que la carte ait reçu ses données, puis un court délai pour
  // laisser arriver d'éventuelles requêtes complémentaires.
  const t0 = Date.now();
  while (!responses && Date.now() - t0 < WAIT_MS) await page.waitForTimeout(500);
  if (responses) await page.waitForTimeout(3000);

  if (!zones.size) throw new Error("la carte du SIA n'a renvoyé aucune zone RTBA");

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
  } catch {}
} finally {
  await browser.close();
}
process.exit(exitCode);
