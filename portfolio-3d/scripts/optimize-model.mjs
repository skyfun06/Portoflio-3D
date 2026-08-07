// Optimise public/chambre_export.blend.glb -> public/chambre.glb
//
// POURQUOI DEUX PROCESS ?
// Le projet contient deux versions de sharp : sharp 0.34.5 au 1er niveau
// (celui qui marche) et sharp 0.35.3 imbrique sous @gltf-transform/functions
// -> ndarray-pixels (binaire natif casse sur cette machine). Si les deux se
// chargent dans le meme process Node, les deux libvips entrent en collision et
// sharp plante ("colourspace: parameter space not set"). On isole donc :
//   - PHASE 1 (ce process) : uniquement sharp -> resize + WebP des textures.
//   - PHASE 2 (process CLI separe) : dedup + prune + meshopt (geometrie).
//
// L'ordre compte aussi : meshopt doit passer EN DERNIER, sinon une reecriture
// ulterieure du .glb decompresserait la geometrie.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTTextureWebP } from '@gltf-transform/extensions';
import sharp from 'sharp';
import { execSync } from 'node:child_process';
import { statSync, rmSync } from 'node:fs';

const INPUT = 'public/chambre_export.blend.glb';
const TMP = 'public/_chambre_webp.glb';
const OUTPUT = 'public/chambre.glb';
const MAX_SIZE = 1024; // dimension max des textures, en pixels
const QUALITY = 80;    // qualite WebP (0-100)

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2) + ' Mo';

// ---- PHASE 1 : textures (redimensionnement <= 1024px + encodage WebP) --------
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(INPUT);
doc.createExtension(EXTTextureWebP).setRequired(true);

let texBefore = 0;
let texAfter = 0;
for (const tex of doc.getRoot().listTextures()) {
  const src = tex.getImage();
  if (!src) continue;
  texBefore += src.byteLength;
  const out = await sharp(Buffer.from(src))
    .resize(MAX_SIZE, MAX_SIZE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: QUALITY })
    .toBuffer();
  texAfter += out.byteLength;
  tex.setImage(new Uint8Array(out)).setMimeType('image/webp');
}
await io.write(TMP, doc);

// ---- PHASE 2 : dedup + prune + meshopt, dans un process CLI separe -----------
// stderr est ignore : libvips crache des "GLib-GObject-CRITICAL" inoffensifs.
const cmd =
  `npx gltf-transform optimize ${TMP} ${OUTPUT} ` +
  `--compress meshopt --texture-compress false --palette false --simplify false`;
execSync(cmd, { stdio: ['ignore', 'inherit', 'ignore'] });

rmSync(TMP, { force: true });

// ---- Rapport de poids -------------------------------------------------------
const before = statSync(INPUT).size;
const after = statSync(OUTPUT).size;
console.log('\nTextures :', mb(texBefore), '->', mb(texAfter));
console.log('Fichier  :', mb(before), '->', mb(after),
  `( -${(100 * (1 - after / before)).toFixed(1)}% )`);
