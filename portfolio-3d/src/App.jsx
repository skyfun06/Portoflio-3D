import { Canvas, useFrame } from "@react-three/fiber";
import { useGLTF, useTexture, Environment, Loader } from "@react-three/drei";
import { EffectComposer, Bloom, ToneMapping, N8AO } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import { RepeatWrapping, SRGBColorSpace, Object3D, Vector3 } from "three"; // Object3D : cible du spot ; Vector3 : caméra
import { Suspense, useEffect, useRef, useState, useMemo } from "react";

// Le fichier est dans /public, servi à la racine "/" par Vite (jamais "/public/...")
// Version optimisée générée par `npm run optimize:model` (WebP + meshopt, ~12 Mo).
const MODEL_URL = "/chambre.glb";

// ─────────────────────────────────────────────────────────────────────────────
// RÉGLAGES DE L'AMBIANCE — tout ce qui se peaufine se trouve ici.
// ─────────────────────────────────────────────────────────────────────────────
const BACKGROUND = "#04050a";       // couleur du fond (bleu nuit très sombre)
const AMBIENT_COLOR = "#5f7bb0";    // teinte de la lumière ambiante (bleutée)
const AMBIENT_INTENSITY = 0.32;     // ↓ moins de lumière « plate » : le relief vient de l'AO + l'env
const ENV_INTENSITY = 0.42;         // ↑ l'éclairage directionnel (reflets/env) porte l'ambiance = + réaliste
const ENV_RESOLUTION = 512;         // finesse de la sonde d'environnement (reflets plus nets, chargement + long)

// ── OCCLUSION AMBIANTE (N8AO) — assombrit les coins/contacts = gros gain de réalisme
// Plus coûteux au rendu (comme demandé) mais donne la profondeur qui manque à une
// pièce éclairée uniquement en ambiant.
const AO_RADIUS = 0.9;              // rayon de l'ombre de contact (unités monde)
const AO_INTENSITY = 2.6;           // ↑ = coins plus marqués
const AO_DISTANCE_FALLOFF = 1.0;    // atténuation avec la distance
const AO_QUALITY = "ultra";         // performance | low | medium | high | ultra (qualité max)
const AO_COLOR = "#070a14";         // teinte de l'ombre (bleu nuit, pas noir pur)

const EMISSIVE_BOOST = 1.1;         // multiplie l'éclat des écrans / LED / télé
const BLOOM_INTENSITY = 0.45;       // force de la lueur (bloom) — plus subtil
const BLOOM_THRESHOLD = 1.0;        // seuil : seules les sources vraiment vives brillent
const BLOOM_SMOOTHING = 0.4;        // douceur de la transition du bloom
const BLOOM_RADIUS = 0.7;           // étalement du halo (↑ = plus diffus)

// ACES Filmic : compresse les hautes lumières => les écrans ne "crament" pas en
// blanc pur et restent lisibles (rendu doux/cinématographique).
const TONE_MAPPING = ToneMappingMode.ACES_FILMIC;
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// RÉPARATION DE MATÉRIAUX cassés à l'export Blender (ciblage par nom de matériau)
// ─────────────────────────────────────────────────────────────────────────────
const FLOOR_MATERIAL = "Wood Floor Walnut";
const FLOOR_MAP = "/textures/parquet_diff.jpg";       // couleur (albedo) du bois
const FLOOR_NORMAL = "/textures/parquet_nor.jpg";     // relief des lames (normal map, OpenGL)
const FLOOR_ROUGHNESS_MAP = "/textures/parquet_rough.jpg"; // variation mat/brillant des lames
const FLOOR_TILING = 8;             // nb de répétitions du motif sur le sol : ↑ = lames + petites
const FLOOR_COLOR = "#ffffff";      // blanc = neutre, ne teinte pas le bois
const FLOOR_ROUGHNESS = 0.7;        // capte bien la lumière de l'ambiance nocturne

const CARPET_MATERIAL = "round carpet";
const CARPET_COLOR = "#3a3a3a";
const CARPET_ROUGHNESS = 0.9;

const KEYBOARD_MATERIAL = "Keyboard print";
const KEYBOARD_COLOR = "#0a0a0a";
const KEYBOARD_ROUGHNESS = 0.85;

const KEYBOARD_RGB_MATERIAL = "PC_RGB";
const KEYBOARD_RGB_INTENSITY = 0.7;
const KEYBOARD_RGB_COLOR = "#7a3cff";
const KEYBOARD_RGB_DROP_MAP = false;

const POUF_MATERIAL = "pouf";
const POUF_COLOR = "#1a1a1a";
const POUF_ROUGHNESS = 0.9;

// Émissifs blancs trop vifs -> on force leur intensité par nom de matériau.
const EMISSIVE_INTENSITY_OVERRIDES = {
  "letters layout": 0.4,
  "Blender Logo": 0.5,
  "PC_GPU_White": 0.6,
  "Color": 1.5,
  "screen": 1.2,
  "screen.001": 1.2,
  "Laptop14_screen": 1.2,
};

// ═════════════════════════════════════════════════════════════════════════════
// PANTINS INTERACTIFS — positions EXPLICITES et FIABLES (lues dans le .glb via
// les os du squelette + les meubles, pas via un clustering fragile).
// Chaque pantin définit TOUT ce dont on a besoin :
//   hitPos/hitSize : boîte invisible de survol/clic (le SEUL objet raycasté)
//   eyePos/lookTarget : vue POV au clic (yeux du perso + ce qu'il regarde)
//   title/description/siteUrl/codeUrl : contenu du panneau projet
// Tout est réglable ici. Active PANTIN_HITBOX_DEBUG pour VOIR les boîtes.
// ═════════════════════════════════════════════════════════════════════════════
const PANTINS = [
  {
    id: "ScanAvis", // pantin ASSIS AU PC (sur la chaise)
    title: "ScanAvis",
    description:
      "SaaS de collecte d'avis clients par QR code : les commerçants génèrent un QR à scanner en caisse, les clients laissent un avis en quelques secondes.",
    siteUrl: "https://www.qrscanavis.fr/",
    codeUrl: "https://github.com/", // placeholder — mets l'URL du repo ici
    hitPos: [-0.42, 1.1, 0.72],     // centre de la zone de survol (torse du perso assis)
    hitSize: [0.55, 1.4, 0.55],     // [largeur, hauteur, profondeur] de la zone
    eyePos: [-0.37, 1.62, 0.71],    // yeux du perso (tête)
    lookTarget: [-0.45, 1.45, 0.1], // regarde l'écran du PC (devant lui, vers -z)
  },
  {
    id: "WhatItCost", // pantin ASSIS SUR LE POUF (face à la télé)
    title: "WhatItCost",
    description:
      "Jeu multijoueur où l'on devine le budget de films : affronte tes amis en temps réel et découvre les coûts réels du cinéma.",
    siteUrl: "https://whatitcost.fr/",
    codeUrl: "https://github.com/", // placeholder — mets l'URL du repo ici
    hitPos: [0.35, 1.05, 1.69],     // centre de la zone (torse du perso sur le pouf)
    hitSize: [0.55, 1.4, 0.55],
    eyePos: [0.33, 1.55, 1.69],     // yeux du perso
    lookTarget: [1.2, 1.15, 0.8],   // regarde la télé WhatItCost (vers +x)
  },
];

// Pantins INUTILES à masquer, par nom de mesh (le perso DEBOUT près du lit est
// le seul « skinné » : meshes "Beta_Joints"/"Beta_Surface" SANS suffixe .003 —
// les pantins utiles, eux, sont les "*.003"). Ajoute un nom ici pour en masquer.
const HIDE_MESH_NAMES = ["Beta_Joints", "Beta_Surface"];

// ── ZONE DE SURVOL (hitbox invisible) ────────────────────────────────────────
// Le survol/clic est capté par une BOÎTE INVISIBLE (raycast instantané et fiable).
// Passe à true pour VOIR les boîtes en vert et les caler sur les pantins.
const PANTIN_HITBOX_DEBUG = false;

// ── SURVOL : un SPOT s'allume juste AU-DESSUS du pantin survolé ──────────────
const PANTIN_SPOT_INTENSITY = 45;       // ↑ = spot plus fort
const PANTIN_SPOT_ANGLE = 0.24;         // demi-angle du cône (~14°)
const PANTIN_SPOT_PENUMBRA = 0.35;      // douceur du bord du cône
const PANTIN_SPOT_HEIGHT = 3.0;         // hauteur de la lampe au-dessus du perso
const PANTIN_SPOT_DISTANCE = 6;         // portée max
const PANTIN_SPOT_COLOR = "#ffe9c4";    // blanc chaud ; bleu clair = "#bcd6ff"

// ── CAMÉRA (FIXE : aucune navigation libre) ──────────────────────────────────
const CAMERA_START_POS = [0.1, 1.35, 3.6];      // au fond, en deçà du mur, recentrée à gauche
const CAMERA_START_TARGET = [0.15, 0.75, -1.0]; // regard pivoté à droite + incliné vers le bas
const CAMERA_FOV = 50;
const CAMERA_DAMP = 3.5;                // vitesse des transitions (↑ = plus rapide)

// SWAY : léger effet de parallaxe qui suit la souris (rend la vue « vivante »).
const CAMERA_SWAY_POS = 0.06;           // amplitude du déplacement de la caméra
const CAMERA_SWAY_LOOK = 0.35;          // amplitude du déplacement du point regardé

const HIDE_PANTIN_IN_POV = false;       // (les 2 pantins utiles partagent un mesh -> on ne masque pas en POV)
const PANEL_DELAY_MS = 550;             // délai avant l'apparition du panneau (le temps de l'anim caméra)
// ─────────────────────────────────────────────────────────────────────────────

// ═════════════════════════════════════════════════════════════════════════════
// CHAMBRE — charge le décor, répare les matériaux, masque les pantins inutiles.
// Ne gère AUCUN événement : les hitboxes (dans App) s'en chargent.
// ═════════════════════════════════════════════════════════════════════════════
function Chambre() {
  const { scene } = useGLTF(MODEL_URL);

  const { map: floorMap, normalMap: floorNormal, roughnessMap: floorRoughMap } =
    useTexture({
      map: FLOOR_MAP,
      normalMap: FLOOR_NORMAL,
      roughnessMap: FLOOR_ROUGHNESS_MAP,
    });

  // Boost émissif (idempotent via userData._baseEmissive).
  useEffect(() => {
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of materials) {
        if (!mat || !mat.emissive) continue;
        const isEmissive =
          mat.emissiveIntensity > 0 &&
          mat.emissive.r + mat.emissive.g + mat.emissive.b > 0;
        if (!isEmissive) continue;
        if (mat.userData._baseEmissive === undefined) {
          mat.userData._baseEmissive = mat.emissiveIntensity;
        }
        mat.emissiveIntensity = mat.userData._baseEmissive * EMISSIVE_BOOST;
      }
    });
  }, [scene]);

  // Réparation des matériaux cassés à l'export, par nom de matériau.
  useEffect(() => {
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat) continue;
        if (mat.name === FLOOR_MATERIAL) {
          floorMap.colorSpace = SRGBColorSpace;
          for (const tex of [floorMap, floorNormal, floorRoughMap]) {
            tex.wrapS = tex.wrapT = RepeatWrapping;
            tex.repeat.set(FLOOR_TILING, FLOOR_TILING);
            tex.needsUpdate = true;
          }
          mat.map = floorMap;
          mat.normalMap = floorNormal;
          mat.roughnessMap = floorRoughMap;
          mat.color.set(FLOOR_COLOR);
          mat.metalness = 0;
          mat.roughness = FLOOR_ROUGHNESS;
          mat.needsUpdate = true;
        } else if (mat.name === CARPET_MATERIAL) {
          mat.color.set(CARPET_COLOR);
          mat.metalness = 0;
          mat.roughness = CARPET_ROUGHNESS;
        } else if (mat.name === KEYBOARD_MATERIAL) {
          mat.color.set(KEYBOARD_COLOR);
          mat.metalness = 0;
          mat.roughness = KEYBOARD_ROUGHNESS;
        } else if (mat.name === KEYBOARD_RGB_MATERIAL) {
          mat.emissiveIntensity = KEYBOARD_RGB_INTENSITY;
          if (KEYBOARD_RGB_COLOR) mat.emissive.set(KEYBOARD_RGB_COLOR);
          if (KEYBOARD_RGB_DROP_MAP && mat.emissiveMap) {
            mat.emissiveMap = null;
            mat.needsUpdate = true;
          }
        } else if (mat.name === POUF_MATERIAL) {
          mat.color.set(POUF_COLOR);
          mat.metalness = 0;
          mat.roughness = POUF_ROUGHNESS;
        }
      }
    });
  }, [scene, floorMap, floorNormal, floorRoughMap]);

  // Overrides d'émissifs blancs trop vifs (après le boost -> c'est cette valeur qui gagne).
  useEffect(() => {
    scene.traverse((obj) => {
      if (!obj.isMesh) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const mat of mats) {
        if (!mat || !mat.name) continue;
        if (Object.prototype.hasOwnProperty.call(EMISSIVE_INTENSITY_OVERRIDES, mat.name)) {
          mat.emissiveIntensity = EMISSIVE_INTENSITY_OVERRIDES[mat.name];
        }
      }
    });
  }, [scene]);

  // Masque les pantins INUTILES (par nom de mesh).
  useEffect(() => {
    scene.traverse((obj) => {
      if (obj.isMesh && HIDE_MESH_NAMES.includes(obj.name)) obj.visible = false;
    });
  }, [scene]);

  // Le décor n'a AUCUN handler -> il n'est pas raycasté (survol instantané).
  return <primitive object={scene} />;
}

// ═════════════════════════════════════════════════════════════════════════════
// HITBOXES — une boîte invisible par pantin capte survol/clic. Ce sont les SEULS
// objets « écoutés » par R3F -> le raycast ne teste que ces 2 boîtes : réponse
// immédiate, zéro latence, aucun raté.
// ═════════════════════════════════════════════════════════════════════════════
function PantinHitboxes({ disabled, onHover, onSelect }) {
  return PANTINS.map((p) => (
    <mesh
      key={p.id}
      position={p.hitPos}
      onPointerOver={(e) => {
        if (disabled) return;
        e.stopPropagation();
        document.body.style.cursor = "pointer";
        onHover(p.id);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        document.body.style.cursor = "auto";
        onHover(null);
      }}
      onPointerDown={(e) => {
        if (disabled) return;
        e.stopPropagation();
        document.body.style.cursor = "auto";
        onSelect(p.id); // pointerdown = réagit dès l'appui
      }}
    >
      <boxGeometry args={p.hitSize} />
      <meshBasicMaterial
        color="#00ff88"
        transparent
        opacity={PANTIN_HITBOX_DEBUG ? 0.25 : 0}
        depthWrite={false}
      />
    </mesh>
  ));
}

// ═════════════════════════════════════════════════════════════════════════════
// HOVER SPOT — projecteur au-dessus du pantin survolé (lumière positionnelle :
// n'éclaire que son cône, jamais l'autre pantin).
// ═════════════════════════════════════════════════════════════════════════════
function HoverSpot({ pantin }) {
  const target = useMemo(() => new Object3D(), []);
  const [x, y, z] = pantin.hitPos;
  return (
    <>
      <primitive object={target} position={[x, y, z]} />
      <spotLight
        position={[x, y + PANTIN_SPOT_HEIGHT, z]}
        target={target}
        angle={PANTIN_SPOT_ANGLE}
        penumbra={PANTIN_SPOT_PENUMBRA}
        intensity={PANTIN_SPOT_INTENSITY}
        distance={PANTIN_SPOT_DISTANCE}
        color={PANTIN_SPOT_COLOR}
      />
    </>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// CAMERA RIG — caméra FIXE. Elle ne bouge que : clic -> yeux du pantin (POV) ;
// fermeture -> retour vue d'entrée. + léger sway souris en vue d'ensemble.
// ═════════════════════════════════════════════════════════════════════════════
function CameraRig({ view }) {
  const lookRef = useRef(null);
  if (!lookRef.current) lookRef.current = new Vector3(...CAMERA_START_TARGET);
  const goal = useMemo(() => new Vector3(), []);

  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const k = 1 - Math.exp(-CAMERA_DAMP * dt);

    const goalPos = view ? view.eyePos : CAMERA_START_POS;
    const goalLook = view ? view.lookTarget : CAMERA_START_TARGET;
    const sx = view ? 0 : state.pointer.x; // pas de sway en POV
    const sy = view ? 0 : state.pointer.y;

    goal.set(...goalPos);
    goal.x += sx * CAMERA_SWAY_POS;
    goal.y += sy * CAMERA_SWAY_POS;
    state.camera.position.lerp(goal, k);

    goal.set(...goalLook);
    goal.x += sx * CAMERA_SWAY_LOOK;
    goal.y += sy * CAMERA_SWAY_LOOK;
    lookRef.current.lerp(goal, k);
    state.camera.lookAt(lookRef.current);
  });
  return null;
}

// ═════════════════════════════════════════════════════════════════════════════
// APP — flux d'état : hoveredId (survol -> spot) et activeId (clic -> POV + panneau).
// ═════════════════════════════════════════════════════════════════════════════
export default function App() {
  const [hoveredId, setHoveredId] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [panelVisible, setPanelVisible] = useState(false);

  const hovered = PANTINS.find((p) => p.id === hoveredId) ?? null;
  const active = PANTINS.find((p) => p.id === activeId) ?? null;

  const openProject = (id) => {
    setHoveredId(null);
    setActiveId(id);
  };
  const closeProject = () => setActiveId(null);

  // Panneau différé : l'animation caméra se lit d'abord.
  useEffect(() => {
    if (!activeId) {
      setPanelVisible(false);
      return;
    }
    const t = setTimeout(() => setPanelVisible(true), PANEL_DELAY_MS);
    return () => clearTimeout(t);
  }, [activeId]);

  // Échap = fermer.
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && closeProject();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", position: "relative" }}>
      <Canvas
        dpr={[1, 2]}                 // netteté écrans HiDPI (rendu + lourd)
        camera={{ position: CAMERA_START_POS, fov: CAMERA_FOV }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={[BACKGROUND]} />
        <ambientLight color={AMBIENT_COLOR} intensity={AMBIENT_INTENSITY} />

        <Suspense fallback={null}>
          <Chambre />
          <Environment
            preset="night"
            environmentIntensity={ENV_INTENSITY}
            resolution={ENV_RESOLUTION}
          />
        </Suspense>

        {/* Zones de survol invisibles (les SEULS objets écoutés -> raycast instantané) */}
        <PantinHitboxes
          disabled={!!activeId}
          onHover={setHoveredId}
          onSelect={openProject}
        />

        {/* Spot au-dessus du pantin survolé (jamais pendant un POV) */}
        {hovered && !activeId && <HoverSpot pantin={hovered} />}

        {/* Caméra fixe + POV (AUCUN OrbitControls) */}
        <CameraRig view={active} />

        <EffectComposer multisampling={8}>
          <N8AO
            aoRadius={AO_RADIUS}
            intensity={AO_INTENSITY}
            distanceFalloff={AO_DISTANCE_FALLOFF}
            quality={AO_QUALITY}
            color={AO_COLOR}
            halfRes={false}
          />
          <Bloom
            intensity={BLOOM_INTENSITY}
            luminanceThreshold={BLOOM_THRESHOLD}
            luminanceSmoothing={BLOOM_SMOOTHING}
            radius={BLOOM_RADIUS}
            mipmapBlur
          />
          <ToneMapping mode={TONE_MAPPING} />
        </EffectComposer>
      </Canvas>

      {/* ── PANNEAU PROJET (overlay HTML) ─────────────────────────────────── */}
      {active && panelVisible && (
        <div style={styles.backdrop} onClick={closeProject}>
          <aside style={styles.panel} onClick={(e) => e.stopPropagation()}>
            <button style={styles.close} onClick={closeProject} aria-label="Fermer">
              ✕
            </button>
            <h2 style={styles.title}>{active.title}</h2>
            <p style={styles.desc}>{active.description}</p>
            <div style={styles.actions}>
              <a style={styles.btnPrimary} href={active.siteUrl} target="_blank" rel="noreferrer">
                Voir le site
              </a>
              <a style={styles.btnGhost} href={active.codeUrl} target="_blank" rel="noreferrer">
                Voir le code
              </a>
            </div>
          </aside>
        </div>
      )}

      <Loader />
    </div>
  );
}

// ── Styles du panneau projet ─────────────────────────────────────────────────
const styles = {
  backdrop: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "flex-end",
    background: "rgba(2, 4, 10, 0.35)",
    zIndex: 10,
  },
  panel: {
    position: "relative",
    width: "min(380px, 90vw)",
    margin: "0 clamp(16px, 5vw, 64px)",
    padding: "28px 26px 24px",
    borderRadius: 14,
    background: "rgba(10, 14, 26, 0.92)",
    border: "1px solid rgba(158, 207, 255, 0.25)",
    boxShadow: "0 12px 40px rgba(0, 0, 0, 0.55)",
    color: "#e8eefc",
    fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
    backdropFilter: "blur(6px)",
  },
  close: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 30,
    height: 30,
    borderRadius: 8,
    border: "1px solid rgba(158, 207, 255, 0.25)",
    background: "transparent",
    color: "#9ecfff",
    fontSize: 14,
    cursor: "pointer",
    lineHeight: 1,
  },
  title: {
    margin: "0 0 10px",
    fontSize: 26,
    fontWeight: 700,
    color: "#ffffff",
    letterSpacing: 0.3,
  },
  desc: { margin: "0 0 22px", fontSize: 14.5, lineHeight: 1.6, color: "#b8c4de" },
  actions: { display: "flex", gap: 10, flexWrap: "wrap" },
  btnPrimary: {
    padding: "10px 18px",
    borderRadius: 9,
    background: "#3d7dd8",
    color: "#ffffff",
    fontSize: 14,
    fontWeight: 600,
    textDecoration: "none",
  },
  btnGhost: {
    padding: "10px 18px",
    borderRadius: 9,
    border: "1px solid rgba(158, 207, 255, 0.4)",
    color: "#9ecfff",
    fontSize: 14,
    fontWeight: 600,
    textDecoration: "none",
  },
};

useGLTF.preload(MODEL_URL);
