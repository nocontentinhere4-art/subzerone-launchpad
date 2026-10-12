// The coin art's symbols (2026-10-12, the owner's rule): the ONE symbol built into the lettermark must say the idea's
// core subject in one second, literally. pickSymbol() finds the idea's main noun in a keyword table (English, Italian,
// Japanese romaji; extend KEYWORDS below) and maps it to its most recognisable pictogram; only when nothing matches does
// it fall back to an abstract glyph. Every pictogram is our own geometric drawing in a 100x100 box centred on 50,50 that
// fits a circle of radius ~46, drawn in two colours: f (the symbol) and b (the ground it sits on), so the same drawing
// works white-on-black inside a counter and black-on-white on a disc. No brand marks, no mascots, no text.

const star = (cx, cy, ro, ri, n = 5, rot = -90) => Array.from({ length: n * 2 }, (_, i) => {
  const a = ((rot + (i * 180) / n) * Math.PI) / 180, r = i % 2 ? ri : ro;
  return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
}).join(' ');

/** id -> { say: the phrase the AI prompt uses, draw(f, b): SVG markup in the 100x100 box } */
export const PICTOGRAMS = {
  robot: { say: 'a simple robot face: a rounded square head with two square eyes and one short antenna with a ball on top',
    draw: (f, b) => `<rect x="47" y="10" width="6" height="18" fill="${f}"/><circle cx="50" cy="11" r="7" fill="${f}"/>` +
      `<rect x="16" y="28" width="68" height="56" rx="16" fill="${f}"/><rect x="8" y="46" width="10" height="20" rx="3" fill="${f}"/><rect x="82" y="46" width="10" height="20" rx="3" fill="${f}"/>` +
      `<rect x="30" y="46" width="14" height="14" rx="2" fill="${b}"/><rect x="56" y="46" width="14" height="14" rx="2" fill="${b}"/><rect x="38" y="70" width="24" height="5" rx="2.5" fill="${b}"/>` },
  qubit: { say: 'a 3x3 grid of round qubit dots, the centre dot slightly larger',
    draw: (f) => [26, 50, 74].flatMap((y) => [26, 50, 74].map((x) => `<circle cx="${x}" cy="${y}" r="${x === 50 && y === 50 ? 11 : 8.5}" fill="${f}"/>`)).join('') },
  train: { say: 'the front of a train: rounded body, wide windscreen, two round headlights, two rails below',
    draw: (f, b) => `<rect x="22" y="10" width="56" height="66" rx="16" fill="${f}"/><rect x="30" y="20" width="40" height="24" rx="5" fill="${b}"/>` +
      `<circle cx="35" cy="60" r="5.5" fill="${b}"/><circle cx="65" cy="60" r="5.5" fill="${b}"/>` +
      `<path d="M33 76 L22 92 M67 76 L78 92" stroke="${f}" stroke-width="7" stroke-linecap="round"/>` },
  cat: { say: 'a cat face: round head, two pointed ears, two oval eyes, small nose',
    draw: (f, b) => `<path d="M17 50 L22 10 L45 30 Z M83 50 L78 10 L55 30 Z" fill="${f}" stroke="${f}" stroke-width="4" stroke-linejoin="round"/><circle cx="50" cy="58" r="33" fill="${f}"/>` +
      `<ellipse cx="37" cy="55" rx="5.5" ry="8" fill="${b}"/><ellipse cx="63" cy="55" rx="5.5" ry="8" fill="${b}"/><path d="M45 68 H55 L50 74 Z" fill="${b}"/>` },
  dog: { say: 'a dog face: round head, two floppy ears, two dot eyes, a round nose',
    draw: (f, b) => `<rect x="26" y="18" width="48" height="62" rx="24" fill="${f}"/>` +
      `<ellipse cx="20" cy="42" rx="10" ry="22" transform="rotate(14 20 42)" fill="${f}" stroke="${b}" stroke-width="3"/><ellipse cx="80" cy="42" rx="10" ry="22" transform="rotate(-14 80 42)" fill="${f}" stroke="${b}" stroke-width="3"/>` +
      `<circle cx="40" cy="46" r="5" fill="${b}"/><circle cx="60" cy="46" r="5" fill="${b}"/><ellipse cx="50" cy="63" rx="8" ry="6" fill="${b}"/>` },
  ramen: { say: 'a ramen bowl seen from the side with a pair of chopsticks resting in it',
    draw: (f, b) => `<path d="M56 46 L88 12 M66 48 L94 22" stroke="${f}" stroke-width="5.5" stroke-linecap="round"/>` +
      `<path d="M10 50 H90 A40 40 0 0 1 10 50 Z" fill="${f}"/><rect x="36" y="86" width="28" height="6" rx="3" fill="${f}"/><rect x="10" y="56" width="80" height="4" fill="${b}"/>` +
      `<path d="M24 40 q4 -6 0 -12 t0 -12 M38 40 q4 -6 0 -12 t0 -12" stroke="${f}" stroke-width="4" fill="none" stroke-linecap="round"/>` },
  sushi: { say: 'a maki sushi roll cross-section (a ring with a filled centre) with a pair of chopsticks above it',
    draw: (f, b) => `<path d="M10 22 L90 6 M10 31 L90 15" stroke="${f}" stroke-width="5" stroke-linecap="round"/>` +
      `<circle cx="50" cy="64" r="28" fill="${f}"/><circle cx="50" cy="64" r="20" fill="${b}"/><circle cx="50" cy="64" r="9" fill="${f}"/>` +
      `<circle cx="38" cy="57" r="2.4" fill="${f}"/><circle cx="62" cy="58" r="2.4" fill="${f}"/><circle cx="57" cy="76" r="2.4" fill="${f}"/><circle cx="40" cy="73" r="2.4" fill="${f}"/>` },
  onigiri: { say: 'an onigiri rice ball: a rounded triangle with a nori band at the bottom',
    draw: (f, b) => `<path d="M50 12 C58 12 90 66 86 78 C83 88 17 88 14 78 C10 66 42 12 50 12 Z" fill="${f}"/><rect x="36" y="60" width="28" height="28" rx="3" fill="${b}"/>` },
  note: { say: 'a pair of beamed music notes',
    draw: (f) => `<ellipse cx="31" cy="76" rx="13" ry="10" transform="rotate(-20 31 76)" fill="${f}"/><ellipse cx="71" cy="68" rx="13" ry="10" transform="rotate(-20 71 68)" fill="${f}"/>` +
      `<rect x="38" y="22" width="7" height="54" fill="${f}"/><rect x="78" y="14" width="7" height="54" fill="${f}"/><path d="M38 22 L85 12 V26 L38 36 Z" fill="${f}"/>` },
  controller: { say: 'a game controller with a d-pad and two round buttons',
    draw: (f, b) => `<rect x="8" y="32" width="84" height="38" rx="19" fill="${f}"/><circle cx="25" cy="66" r="15" fill="${f}"/><circle cx="75" cy="66" r="15" fill="${f}"/>` +
      `<rect x="18" y="47" width="18" height="6" rx="1" fill="${b}"/><rect x="24" y="41" width="6" height="18" rx="1" fill="${b}"/><circle cx="66" cy="45" r="4.5" fill="${b}"/><circle cx="75" cy="54" r="4.5" fill="${b}"/>` },
  rocket: { say: 'a rocket pointing up with one round window and two fins',
    draw: (f, b) => `<path d="M50 6 C67 20 71 44 66 68 H34 C29 44 33 20 50 6 Z" fill="${f}"/><circle cx="50" cy="36" r="8" fill="${b}"/>` +
      `<path d="M34 50 L18 74 L35 69 Z M66 50 L82 74 L65 69 Z" fill="${f}"/><path d="M41 72 H59 L50 94 Z" fill="${f}"/>` },
  receipt: { say: 'a paper receipt with a zigzag torn bottom edge and a few printed lines',
    draw: (f, b) => `<path d="M24 8 H76 V90 L69.5 84 L63 90 L56.5 84 L50 90 L43.5 84 L37 90 L30.5 84 L24 90 Z" fill="${f}"/>` +
      `<rect x="33" y="20" width="34" height="5" rx="2" fill="${b}"/><rect x="33" y="32" width="24" height="5" rx="2" fill="${b}"/><rect x="33" y="44" width="34" height="5" rx="2" fill="${b}"/>` +
      `<rect x="33" y="56" width="18" height="5" rx="2" fill="${b}"/><rect x="33" y="68" width="34" height="6" rx="2" fill="${b}"/>` },
  moon: { say: 'a crescent moon with one small star',
    draw: (f, b) => `<circle cx="46" cy="52" r="36" fill="${f}"/><circle cx="64" cy="40" r="30" fill="${b}"/><polygon points="${star(76, 74, 10, 4, 4, 0)}" fill="${f}"/>` },
  glass: { say: 'a cocktail glass with an olive',
    draw: (f, b) => `<path d="M14 16 H86 L50 54 Z" fill="${f}"/><rect x="47" y="52" width="6" height="28" fill="${f}"/><rect x="30" y="80" width="40" height="7" rx="3.5" fill="${f}"/><circle cx="42" cy="26" r="5.5" fill="${b}"/>` },
  beer: { say: 'a beer mug with a foam top and a handle',
    draw: (f, b) => `<rect x="20" y="26" width="46" height="62" rx="6" fill="${f}"/><path d="M66 40 H74 A10 10 0 0 1 84 50 V62 A10 10 0 0 1 74 72 H66" stroke="${f}" stroke-width="8" fill="none"/>` +
      `<circle cx="27" cy="22" r="10" fill="${f}"/><circle cx="43" cy="18" r="12" fill="${f}"/><circle cx="59" cy="22" r="10" fill="${f}"/><rect x="31" y="44" width="5" height="34" rx="2.5" fill="${b}"/><rect x="50" y="44" width="5" height="34" rx="2.5" fill="${b}"/>` },
  pin: { say: 'a map location pin',
    draw: (f, b) => `<path d="M50 92 C50 92 18 60 18 40 A32 32 0 0 1 82 40 C82 60 50 92 50 92 Z" fill="${f}"/><circle cx="50" cy="40" r="12" fill="${b}"/>` },
  heart: { say: 'a heart',
    draw: (f) => `<path d="M50 86 C20 64 10 48 10 34 C10 21 20 13 32 13 C40 13 46 17 50 24 C54 17 60 13 68 13 C80 13 90 21 90 34 C90 48 80 64 50 86 Z" fill="${f}"/>` },
  eye: { say: 'an eye',
    draw: (f, b) => `<path d="M6 50 Q50 6 94 50 Q50 94 6 50 Z" fill="${f}"/><circle cx="50" cy="50" r="17" fill="${b}"/><circle cx="50" cy="50" r="8" fill="${f}"/>` },
  key: { say: 'a key',
    draw: (f, b) => `<circle cx="28" cy="50" r="20" fill="${f}"/><circle cx="28" cy="50" r="8" fill="${b}"/><rect x="44" y="45" width="48" height="10" fill="${f}"/>` +
      `<rect x="72" y="54" width="8" height="14" fill="${f}"/><rect x="84" y="54" width="8" height="10" fill="${f}"/>` },
  bolt: { say: 'a lightning bolt',
    draw: (f) => `<polygon points="60,4 22,54 46,54 38,96 78,42 54,42 64,4" fill="${f}"/>` },
  star: { say: 'a five-pointed star',
    draw: (f) => `<polygon points="${star(50, 53, 44, 18)}" fill="${f}" stroke="${f}" stroke-width="3" stroke-linejoin="round"/>` },
  wave: { say: 'an ocean wave',
    draw: (f) => `<path d="M8 40 q10.5 -14 21 0 t21 0 t21 0 t21 0 M8 62 q10.5 -14 21 0 t21 0 t21 0 t21 0" stroke="${f}" stroke-width="9" fill="none" stroke-linecap="round"/>` },
  sun: { say: 'a sun with short rays',
    draw: (f) => `<circle cx="50" cy="50" r="20" fill="${f}"/>` + Array.from({ length: 8 }, (_, i) => `<rect x="46" y="6" width="8" height="16" rx="4" fill="${f}" transform="rotate(${i * 45} 50 50)"/>`).join('') },
  house: { say: 'a house with a pitched roof and a door',
    draw: (f, b) => `<path d="M50 10 L92 46 H8 Z" fill="${f}" stroke="${f}" stroke-width="4" stroke-linejoin="round"/><rect x="20" y="44" width="60" height="44" fill="${f}"/><rect x="42" y="60" width="16" height="28" rx="2" fill="${b}"/>` },
  book: { say: 'an open book',
    draw: (f) => `<path d="M47 26 C36 18 22 16 8 20 V80 C22 76 36 78 47 86 Z M53 26 C64 18 78 16 92 20 V80 C78 76 64 78 53 86 Z" fill="${f}"/>` },
  camera: { say: 'a photo camera with a round lens',
    draw: (f, b) => `<rect x="34" y="18" width="32" height="16" rx="4" fill="${f}"/><rect x="8" y="28" width="84" height="56" rx="10" fill="${f}"/>` +
      `<circle cx="50" cy="56" r="20" fill="${b}"/><circle cx="50" cy="56" r="12" fill="${f}"/><rect x="74" y="36" width="10" height="6" rx="2" fill="${b}"/>` },
  coffee: { say: 'a coffee cup with steam',
    draw: (f) => `<path d="M14 40 H70 V66 A22 22 0 0 1 48 88 H36 A22 22 0 0 1 14 66 Z" fill="${f}"/><path d="M70 48 H76 A10 10 0 0 1 76 68 H68" stroke="${f}" stroke-width="7" fill="none"/>` +
      `<path d="M32 32 q5 -6 0 -12 t0 -12 M48 32 q5 -6 0 -12 t0 -12" stroke="${f}" stroke-width="4.5" fill="none" stroke-linecap="round"/>` },
  tea: { say: 'a teacup without handle (yunomi) with steam',
    draw: (f) => `<path d="M18 44 H82 L76 80 A10 10 0 0 1 66 88 H34 A10 10 0 0 1 24 80 Z" fill="${f}"/><path d="M40 36 q5 -6 0 -12 t0 -12 M58 36 q5 -6 0 -12 t0 -12" stroke="${f}" stroke-width="4.5" fill="none" stroke-linecap="round"/>` },
  coin: { say: 'a coin with a raised rim',
    draw: (f, b) => `<circle cx="50" cy="50" r="42" fill="${f}"/><circle cx="50" cy="50" r="32" fill="none" stroke="${b}" stroke-width="4"/><rect x="45" y="32" width="10" height="36" rx="5" fill="${b}"/>` },
  chart: { say: 'a rising bar chart with three bars',
    draw: (f) => `<rect x="12" y="60" width="18" height="28" rx="2" fill="${f}"/><rect x="41" y="40" width="18" height="48" rx="2" fill="${f}"/><rect x="70" y="16" width="18" height="72" rx="2" fill="${f}"/>` },
  dice: { say: 'a die showing five pips',
    draw: (f, b) => `<rect x="12" y="12" width="76" height="76" rx="16" fill="${f}"/>` + [[30, 30], [70, 30], [50, 50], [30, 70], [70, 70]].map(([x, y]) => `<circle cx="${x}" cy="${y}" r="7.5" fill="${b}"/>`).join('') },
  flame: { say: 'a flame',
    draw: (f, b) => `<path d="M50 6 C56 26 80 38 80 62 A30 30 0 0 1 20 62 C20 48 28 40 34 30 C38 40 42 44 46 46 C46 32 44 20 50 6 Z" fill="${f}"/><path d="M50 56 C54 64 62 68 62 76 A12 12 0 0 1 38 76 C38 68 46 64 50 56 Z" fill="${b}"/>` },
  cloud: { say: 'a rain cloud with three drops',
    draw: (f) => `<circle cx="34" cy="48" r="18" fill="${f}"/><circle cx="56" cy="38" r="22" fill="${f}"/><circle cx="74" cy="52" r="15" fill="${f}"/><rect x="18" y="48" width="70" height="18" rx="9" fill="${f}"/>` +
      `<path d="M32 76 L28 88 M50 76 L46 88 M68 76 L64 88" stroke="${f}" stroke-width="5" stroke-linecap="round"/>` },
  plane: { say: 'an airplane seen from above',
    draw: (f) => `<path d="M50 6 C55 6 56 12 56 18 V40 L92 60 V68 L56 58 V78 L67 86 V92 L50 88 L33 92 V86 L44 78 V58 L8 68 V60 L44 40 V18 C44 12 45 6 50 6 Z" fill="${f}"/>` },
  ghost: { say: 'a friendly ghost with two oval eyes',
    draw: (f, b) => `<path d="M20 84 V44 A30 30 0 0 1 80 44 V84 A10 10 0 0 1 60 84 A10 10 0 0 0 40 84 A10 10 0 0 1 20 84 Z" fill="${f}"/><ellipse cx="39" cy="46" rx="5.5" ry="8" fill="${b}"/><ellipse cx="61" cy="46" rx="5.5" ry="8" fill="${b}"/>` },
  flower: { say: 'a five-petal flower',
    draw: (f, b) => Array.from({ length: 5 }, (_, i) => { const a = (-90 + i * 72) * Math.PI / 180; return `<circle cx="${(50 + 24 * Math.cos(a)).toFixed(1)}" cy="${(52 + 24 * Math.sin(a)).toFixed(1)}" r="17" fill="${f}"/>`; }).join('') +
      `<circle cx="50" cy="52" r="11" fill="${b}"/><circle cx="50" cy="52" r="5" fill="${f}"/>` },
  fish: { say: 'a fish seen from the side',
    draw: (f, b) => `<path d="M10 50 C24 26 56 24 72 50 C56 76 24 74 10 50 Z" fill="${f}"/><path d="M68 50 L92 30 V70 Z" fill="${f}"/><circle cx="28" cy="46" r="5" fill="${b}"/>` },
  crown: { say: 'a crown with three points',
    draw: (f, b) => `<path d="M12 78 V30 L32 52 L50 20 L68 52 L88 30 V78 Z" fill="${f}" stroke="${f}" stroke-width="4" stroke-linejoin="round"/><rect x="12" y="64" width="76" height="4" fill="${b}"/>` },
  mic: { say: 'a microphone on a stand',
    draw: (f, b) => `<rect x="36" y="8" width="28" height="48" rx="14" fill="${f}"/><path d="M24 42 A26 26 0 0 0 76 42" stroke="${f}" stroke-width="6" fill="none" stroke-linecap="round"/>` +
      `<rect x="47" y="66" width="6" height="18" fill="${f}"/><rect x="32" y="84" width="36" height="7" rx="3.5" fill="${f}"/><rect x="42" y="24" width="16" height="4" rx="2" fill="${b}"/><rect x="42" y="34" width="16" height="4" rx="2" fill="${b}"/>` },
  clock: { say: 'a clock face with two hands',
    draw: (f, b) => `<circle cx="50" cy="50" r="42" fill="${f}"/><circle cx="50" cy="50" r="33" fill="${b}"/><rect x="46.5" y="24" width="7" height="30" rx="3.5" fill="${f}"/><rect x="46.5" y="46.5" width="24" height="7" rx="3.5" fill="${f}"/>` },
  globe: { say: 'a globe with meridians',
    draw: (f, b) => `<circle cx="50" cy="50" r="42" fill="${f}"/><ellipse cx="50" cy="50" rx="17" ry="42" fill="none" stroke="${b}" stroke-width="4.5"/>` +
      `<path d="M8 50 H92 M15 29 H85 M15 71 H85" stroke="${b}" stroke-width="4.5"/>` },
  lock: { say: 'a padlock',
    draw: (f, b) => `<path d="M32 46 V32 A18 18 0 0 1 68 32 V46" stroke="${f}" stroke-width="10" fill="none"/><rect x="18" y="44" width="64" height="46" rx="8" fill="${f}"/>` +
      `<circle cx="50" cy="62" r="7" fill="${b}"/><rect x="46.5" y="62" width="7" height="16" rx="2" fill="${b}"/>` },
  bag: { say: 'a shopping bag with a handle',
    draw: (f, b) => `<path d="M36 40 V28 A14 14 0 0 1 64 28 V40" stroke="${f}" stroke-width="7" fill="none"/><rect x="16" y="34" width="68" height="56" rx="6" fill="${f}"/><circle cx="36" cy="46" r="3.5" fill="${b}"/><circle cx="64" cy="46" r="3.5" fill="${b}"/>` },
  ticket: { say: 'a ticket with notched sides and a perforation',
    draw: (f, b) => `<rect x="6" y="26" width="88" height="48" rx="6" fill="${f}"/><circle cx="6" cy="50" r="9" fill="${b}"/><circle cx="94" cy="50" r="9" fill="${b}"/>` +
      [32, 42, 52, 62].map((y) => `<rect x="64" y="${y}" width="4" height="6" fill="${b}"/>`).join('') + `<polygon points="${star(36, 50, 13, 5.5)}" fill="${b}"/>` },
  pizza: { say: 'a pizza slice with round toppings',
    draw: (f, b) => `<path d="M50 92 L12 22 Q50 2 88 22 Z" fill="${f}" stroke="${f}" stroke-width="4" stroke-linejoin="round"/><path d="M16 28 Q50 10 84 28" stroke="${b}" stroke-width="3.5" fill="none"/>` +
      `<circle cx="40" cy="40" r="6" fill="${b}"/><circle cx="60" cy="44" r="6" fill="${b}"/><circle cx="50" cy="64" r="5.5" fill="${b}"/>` },
  leaf: { say: 'a leaf with a central vein',
    draw: (f, b) => `<path d="M14 86 C14 42 42 14 88 12 C86 58 58 86 14 86 Z" fill="${f}"/><path d="M20 80 L70 30" stroke="${b}" stroke-width="4.5" stroke-linecap="round"/>` },
  ball: { say: 'a football (soccer ball)',
    draw: (f, b) => `<circle cx="50" cy="50" r="42" fill="${f}"/><polygon points="${star(50, 50, 15, 15, 5).split(' ').filter((_, i) => i % 2 === 0).join(' ')}" fill="${b}"/>` +
      Array.from({ length: 5 }, (_, i) => `<g transform="rotate(${i * 72} 50 50)"><rect x="48" y="18" width="4" height="18" fill="${b}"/><polygon points="${star(50, 10, 12, 12, 5, 90).split(' ').filter((_, k) => k % 2 === 0).join(' ')}" fill="${b}"/></g>`).join('') +
      `<circle cx="50" cy="50" r="47" fill="none" stroke="${b}" stroke-width="10"/>` },
  car: { say: 'a small car seen from the side',
    draw: (f, b) => `<path d="M24 46 L34 26 H66 L78 46 Z" fill="${f}"/><rect x="6" y="44" width="88" height="26" rx="9" fill="${f}"/><path d="M31 44 L38 31 H48 V44 Z M52 31 H63 L71 44 H52 Z" fill="${b}"/>` +
      `<circle cx="28" cy="72" r="13" fill="${b}"/><circle cx="72" cy="72" r="13" fill="${b}"/><circle cx="28" cy="72" r="9" fill="${f}"/><circle cx="72" cy="72" r="9" fill="${f}"/>` },
  people: { say: 'two people side by side (simple heads and shoulders)',
    draw: (f, b) => `<circle cx="34" cy="34" r="13" fill="${f}"/><path d="M10 82 A24 24 0 0 1 58 82 Z" fill="${f}"/>` +
      `<circle cx="66" cy="34" r="13" fill="${f}" stroke="${b}" stroke-width="4"/><path d="M42 82 A24 24 0 0 1 90 82 Z" fill="${f}" stroke="${b}" stroke-width="4"/>` },
  chat: { say: 'a speech bubble with three dots',
    draw: (f, b) => `<rect x="8" y="16" width="84" height="56" rx="18" fill="${f}"/><path d="M24 66 L20 90 L44 70 Z" fill="${f}"/>` +
      `<circle cx="32" cy="44" r="6" fill="${b}"/><circle cx="50" cy="44" r="6" fill="${b}"/><circle cx="68" cy="44" r="6" fill="${b}"/>` },
  phone: { say: 'a smartphone',
    draw: (f, b) => `<rect x="26" y="6" width="48" height="88" rx="10" fill="${f}"/><rect x="32" y="16" width="36" height="62" rx="3" fill="${b}"/><circle cx="50" cy="86" r="3.5" fill="${b}"/>` },
  skull: null,                                                                // deliberately absent
  // abstract fallbacks: only when the idea names nothing drawable
  spark: { say: 'a four-pointed spark', draw: (f) => `<polygon points="${star(50, 50, 46, 11, 4, -90)}" fill="${f}"/>` },
  rings: { say: 'two concentric rings around a dot', draw: (f, b) => `<circle cx="50" cy="50" r="42" fill="${f}"/><circle cx="50" cy="50" r="33" fill="${b}"/><circle cx="50" cy="50" r="24" fill="${f}"/><circle cx="50" cy="50" r="15" fill="${b}"/><circle cx="50" cy="50" r="7" fill="${f}"/>` },
  bars: { say: 'three equal vertical bars', draw: (f) => `<rect x="14" y="14" width="16" height="72" rx="3" fill="${f}"/><rect x="42" y="14" width="16" height="72" rx="3" fill="${f}"/><rect x="70" y="14" width="16" height="72" rx="3" fill="${f}"/>` },
  grid: { say: 'a 2x2 grid of squares', draw: (f) => `<rect x="14" y="14" width="32" height="32" rx="4" fill="${f}"/><rect x="54" y="14" width="32" height="32" rx="4" fill="${f}"/><rect x="14" y="54" width="32" height="32" rx="4" fill="${f}"/><rect x="54" y="54" width="32" height="32" rx="4" fill="${f}"/>` },
};
delete PICTOGRAMS.skull;
export const ABSTRACT = ['spark', 'rings', 'bars', 'grid'];

// keyword -> pictogram. Whole words, lower case, accents stripped; a trailing s/es is also tried. Weight < 1: generic
// words that should lose to a concrete subject named in the same idea ("quantum launchpad" is about quantum).
const W = (id, words, weight = 1) => words.split(/\s+/).filter(Boolean).map((w) => [w, id, weight]);
export const KEYWORDS = new Map([
  ...W('robot', 'agent agents agente agenti ai a.i. llm llms gpt bot bots robot robots robotto chatbot assistant assistente automation autonomous android androide automa jinkou'),
  ...W('qubit', 'quantum qubit qubits quantistico quantistica quanti ryoushi post-quantum postquantum pq'),
  ...W('train', 'train trains rail railway railways metro subway shinkansen densha treno treni ferrovia tram station stazione eki'),
  ...W('cat', 'cat cats kitty kitten kittens neko gatto gatti gatta meow nyan'),
  ...W('dog', 'dog dogs puppy puppies inu cane cani doggo shiba'),
  ...W('ramen', 'ramen noodle noodles udon soba pho'),
  ...W('sushi', 'sushi maki nigiri sashimi temaki'),
  ...W('onigiri', 'onigiri omusubi'),
  ...W('note', 'music song songs beat beats dj musica canzone canzoni ongaku karaoke playlist melody melodia synth band concerto'),
  ...W('controller', 'game games gaming gamer gamers arcade gioco giochi videogame videogioco geemu console'),
  ...W('rocket', 'rocket rockets spaceship razzo roketto space spazio uchuu'),
  ...W('rocket', 'launch launchpad lancio moonshot', 0.4),
  ...W('receipt', 'receipt receipts invoice bill scontrino scontrini ricevuta ricevute reshiito'),
  ...W('moon', 'night nights moon luna notte yoru tsuki midnight mezzanotte sleep dream dreams sogno sogni', 0.6),
  ...W('glass', 'bar bars cocktail cocktails drink drinks izakaya pub wine vino aperitivo nomikai sake'),
  ...W('beer', 'beer beers birra birre biiru brewery'),
  ...W('pin', 'map maps mappa mappe chizu place places location spot spots guide guida'),
  ...W('heart', 'love heart hearts dating amore cuore koi suki'),
  ...W('eye', 'eye eyes watch watcher vision occhio occhi spy surveillance'),
  ...W('key', 'key keys password passwords secret secrets chiave chiavi kagi'),
  ...W('bolt', 'energy electric lightning fulmine flash power volt'),
  ...W('star', 'star stars stella stelle hoshi idol idols fame'),
  ...W('wave', 'sea ocean wave waves surf mare onda onde umi nami beach spiaggia'),
  ...W('sun', 'sun sole taiyou summer estate morning mattina sunrise'),
  ...W('house', 'house home casa apartment apartments room rooms rent'),
  ...W('book', 'book books read reading library libro libri hon manga novel story stories storia'),
  ...W('camera', 'photo photos camera picture pictures foto shashin selfie'),
  ...W('coffee', 'coffee cafe caffe kissaten espresso'),
  ...W('tea', 'tea matcha ocha'),
  ...W('chart', 'chart charts trading trader stocks stock price prices grafico borsa'),
  ...W('dice', 'dice luck lucky random casino bet bets odds dado dadi lottery lotteria omikuji gamble'),
  ...W('flame', 'fire hot spicy fuoco burn flame flames piccante'),
  ...W('cloud', 'weather rain cloud clouds meteo pioggia ame tenki'),
  ...W('plane', 'plane planes flight flights airport aereo aerei hikouki'),
  ...W('ghost', 'ghost ghosts horror haunted fantasma fantasmi yurei yuurei obake spooky'),
  ...W('flower', 'flower flowers garden fiore fiori hana sakura bloom giardino'),
  ...W('fish', 'fish fishing pesce pesci sakana'),
  ...W('crown', 'king queen royal crown regina corona'),
  ...W('mic', 'podcast podcasts mic microphone voice radio comedy standup'),
  ...W('clock', 'time clock clocks alarm tempo orologio jikan tokei deadline'),
  ...W('globe', 'world global mondo sekai earth planet pianeta'),
  ...W('lock', 'privacy private lock vault secure security sicurezza'),
  ...W('bag', 'shop shops store stores shopping negozio konbini'),
  ...W('ticket', 'ticket tickets event events biglietto biglietti kippu'),
  ...W('pizza', 'pizza pizzeria'),
  ...W('leaf', 'nature green tree trees leaf leaves forest bosco foresta mori albero'),
  ...W('ball', 'football soccer calcio sakkaa ball'),
  ...W('car', 'car cars auto drive driving taxi kuruma macchina'),
  ...W('people', 'people community friends friend together social gente amici tomodachi', 0.5),
  ...W('chat', 'chat message messages confession confessions confessione gossip talk', 0.8),
  ...W('phone', 'phone phones mobile smartphone telefono sumaho app', 0.5),
  ...W('coin', 'coin coins token tokens money cash moneta soldi okane fee fees crypto memecoin', 0.3),
].map(([w, id, weight]) => [w, { id, weight }]));

const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9][a-z0-9.+-]*[a-z0-9]|[a-z0-9]/g) || [];
const lookup = (w) => KEYWORDS.get(w) || (w.endsWith('es') && KEYWORDS.get(w.slice(0, -2))) || (w.endsWith('s') && KEYWORDS.get(w.slice(0, -1))) || null;

/**
 * The idea's main noun -> a pictogram. Fields weigh name 3, title 2, concept 1; an earlier word in a field weighs a
 * little more; generic words carry their own lower weight. -> { id, say, keyword|null, abstract: bool }
 */
export function pickSymbol({ name, title, concept }, seed = '') {
  const score = new Map(), first = new Map();
  let order = 0;
  for (const [text, fw] of [[name, 3], [title, 2], [concept, 1]]) {
    const ws = words(text).slice(0, 400);
    ws.forEach((w, i) => {
      const hit = lookup(w) || (w.includes('-') ? w.split(/[-.+]/).map(lookup).find(Boolean) : null);
      order++;
      if (!hit || !PICTOGRAMS[hit.id]) return;
      score.set(hit.id, (score.get(hit.id) || 0) + fw * hit.weight * (1 + 0.5 / (1 + i)));
      if (!first.has(hit.id)) first.set(hit.id, { order, keyword: w });
    });
  }
  const ranked = [...score].sort((a, b) => b[1] - a[1] || first.get(a[0]).order - first.get(b[0]).order);
  if (ranked.length) {
    const id = ranked[0][0];
    return { id, say: PICTOGRAMS[id].say, keyword: first.get(id).keyword, abstract: false };
  }
  let h = 0;
  for (const c of String(seed)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const id = ABSTRACT[h % ABSTRACT.length];
  return { id, say: PICTOGRAMS[id].say, keyword: null, abstract: true };
}

/** The pictogram placed in a circle of radius r centred on cx,cy (fits inside it with a margin). */
export function pictogram(id, cx, cy, r, f, b) {
  const p = PICTOGRAMS[id] || PICTOGRAMS.spark;
  const s = (r * 0.8) / 46;
  return `<g transform="translate(${(cx - 50 * s).toFixed(2)} ${(cy - 50 * s).toFixed(2)}) scale(${s.toFixed(4)})">${p.draw(f, b)}</g>`;
}
