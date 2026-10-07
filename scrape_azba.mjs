// ─────────────────────────────────────────────────────────────────────────────
// ParaXC — récupération des activations RTBA / AZBA
//
// Ouvre la carte AZBA officielle du SIA dans un vrai navigateur (Chromium sans
// fenêtre), exactement comme un visiteur. La carte télécharge elle-même ses
// données (zones RTBA + créneaux d'activation) ; le script les lit au passage
// et les écrit dans rtba.json. Le planning GitHub publie ensuite ce fichier sur
// la branche « data » du dépôt, où ParaXC_backend.php vient le chercher.
//
// Variables d'environnement (toutes facultatives) :
//   OUTPUT_FILE        fichier écrit (défaut : rtba.json)
//   SIA_PAGE_URL       page à ouvrir — par défaut la carte AZBA du SIA
//   PARAXC_UPLOAD_URL  + PARAXC_UPLOAD_KEY : envoi direct au serveur ParaXC
//                      (?action=rtba_upload), en plus de la publication. Un échec
//                      de cet envoi n'est qu'un avertissement.
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';

const PAGE_URL   = process.env.SIA_PAGE_URL || 'https://www.sia.aviation-civile.gouv.fr/azbaEx/?lang=fr';
// Nettoyage des espaces, guillemets ou retours à la ligne collés par erreur dans le secret
const UPLOAD_URL = (process.env.PARAXC_UPLOAD_URL || '').trim().replace(/^["']|["']$/g, '');
const UPLOAD_KEY = (process.env.PARAXC_UPLOAD_KEY || '').trim();
const OUTPUT     = process.env.OUTPUT_FILE || 'rtba.json';
const WAIT_MS    = 180_000; // délai maximal pour que la carte charge ses données (3 min)


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

// Extrait la liste des zones quelle que soit la forme de la réponse :
// JSON-LD ({"hydra:member":[…]} ou {"member":[…]}), liste simple ([…]),
// ou liste rangée sous une autre clé. Une zone = objet avec un contour.
const isZone = (o) => o && typeof o === 'object' && Array.isArray(o.coordinates);
function extractZones(data, depth = 0) {
  if (Array.isArray(data)) return data.some(isZone) ? data.filter(isZone) : [];
  if (!data || typeof data !== 'object' || depth > 3) return [];
  for (const k of ['hydra:member', 'member', 'data', 'items', 'results']) {
    const z = extractZones(data[k], depth + 1);
    if (z.length) return z;
  }
  for (const v of Object.values(data)) {
    const z = extractZones(v, depth + 1);
    if (z.length) return z;
  }
  return [];
}
const shapeOf = (d) => Array.isArray(d) ? `liste de ${d.length} éléments` :
  d && typeof d === 'object' ? `objet {${Object.keys(d).slice(0, 8).join(', ')}}` : typeof d;

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
    const members = extractZones(data);
    members.forEach((z) => zones.set(z['@id'] || z.id || `${z.codeId}-${z.name}`, z));
    responses++;
    const msg = `${sec()}s 📥 ${members.length} zones lues (${shapeOf(data)}) — ${res.url().replace(/^https?:\/\/[^/]+/, '')}`;
    apiLog.push(msg);
    console.log(msg);
    if (!members.length) {
      // Forme inconnue : on garde la réponse pour pouvoir adapter le script
      mkdirSync('debug', { recursive: true });
      writeFileSync(`debug/rtba_vide_${responses}.txt`, `URL : ${res.url()}\nForme : ${shapeOf(data)}\n\n${text.slice(0, 6000)}`);
    }
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
  if (responses) await page.waitForTimeout(5000);

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

  writeFileSync(OUTPUT, JSON.stringify(payload));
  console.log(`💾 ${OUTPUT} écrit`);

  if (UPLOAD_URL && UPLOAD_KEY) try {
    let target;
    try { target = new URL(UPLOAD_URL); }
    catch { throw new Error(`PARAXC_UPLOAD_URL n'est pas une adresse valide (${UPLOAD_URL.length} caractères, commence par « ${UPLOAD_URL.slice(0, 12)} »)`); }
    console.log(`📤 Envoi vers ${target.protocol}//${target.host}${target.pathname}${target.search}`);
    const send = () => fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ParaXC-Key': UPLOAD_KEY, 'User-Agent': 'ParaXC-AZBA/1.0 (GitHub Actions)' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000),
    });
    let r;
    try {
      try { r = await send(); }
      catch { await new Promise((ok) => setTimeout(ok, 5000)); r = await send(); } // un nouvel essai
    } catch (err) {
      // « fetch failed » cache la vraie cause : on la détaille
      const c = err.cause || {};
      const code = c.code || c.name || '';
      const hints = {
        ENOTFOUND: 'nom de domaine introuvable : vérifiez l\'adresse dans le secret',
        ECONNREFUSED: 'connexion refusée par le serveur',
        ECONNRESET: 'connexion coupée par le serveur (pare-feu de l\'hébergeur ?)',
        ETIMEDOUT: 'pas de réponse du serveur (pare-feu de l\'hébergeur ?)',
        UND_ERR_CONNECT_TIMEOUT: 'pas de réponse du serveur (pare-feu de l\'hébergeur ?)',
        UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificat HTTPS incomplet sur le serveur (chaîne intermédiaire manquante)',
        CERT_HAS_EXPIRED: 'certificat HTTPS expiré',
        ERR_TLS_CERT_ALTNAME_INVALID: 'certificat HTTPS ne correspondant pas au nom de domaine',
        DEPTH_ZERO_SELF_SIGNED_CERT: 'certificat HTTPS auto-signé',
        SELF_SIGNED_CERT_IN_CHAIN: 'certificat HTTPS auto-signé',
      };
      throw new Error(`impossible de joindre ${target.host} : ${code} ${c.message || err.message}` +
        (hints[code] ? ` → ${hints[code]}` : ''));
    }
    const txt = await r.text();
    if (!r.ok) throw new Error(`envoi au serveur ParaXC refusé : HTTP ${r.status} ${txt.slice(0, 300)}`);
    console.log(`📤 Envoyé au serveur ParaXC : ${txt.slice(0, 200)}`);
  } catch (err) {
    // La publication sur GitHub reste la voie principale : simple avertissement
    console.warn(`⚠ Envoi direct non abouti (sans conséquence, le serveur lit la branche data) : ${err.message}`);
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
    writeFileSync('debug/erreur.txt', `${new Date().toISOString()}\n${e.message}\n`);
  } catch {}
} finally {
  await browser.close();
}
process.exit(exitCode);
