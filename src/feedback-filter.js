// What anonymous feedback may not contain: anyone's name, swearing or slurs, and
// anything that points at a person directly (an email address, a phone number, an
// @mention). It's checked as people type and again when it's sent; an admin still
// reads every post before anyone else sees it.

// Swearing and slurs. Stems block any word they start, so "fucking" and "shitty"
// are caught; whole words only block that word (and its plural), so "scrap",
// "cocktail" and "flame retardant" are fine.
const STEMS = ['fuck', 'fuk', 'fck', 'shit', 'sht', 'cunt', 'twat', 'wank', 'bollock', 'bastard', 'bitch', 'motherf', 'dickhead',
  'arsehol', 'asshol', 'bellend', 'tosser', 'whore', 'nigg', 'fagg', 'slut', 'shag'];
const WORDS = ['crap', 'crappy', 'piss', 'pissed', 'pissing', 'prick', 'dick', 'cock', 'arse', 'arsed', 'ass', 'sod', 'sodding', 'bugger',
  'bloody', 'damn', 'goddamn', 'nonce', 'paki', 'chink', 'spic', 'kike', 'tranny', 'retard', 'retarded', 'spaz', 'spastic', 'fag', 'mong',
  'muppet', 'idiot', 'moron', 'knobhead', 'dickhead', 'wazzock', 'pillock', 'numpty'];

// Names that are also everyday words: these only count as a name when written with
// a capital letter partway through a sentence ("ask Key", not "the key issue").
const EVERYDAY = new Set(['key', 'mark', 'banks', 'hart', 'beech', 'will', 'bill', 'rose', 'grace', 'hope', 'may', 'june', 'art', 'page', 'cook',
  'baker', 'hunter', 'brown', 'green', 'white', 'black', 'young', 'king', 'hill', 'wood', 'stone', 'bishop', 'frank', 'dean', 'chase', 'miles',
  'lane', 'price', 'rich', 'sharp', 'ward', 'wells', 'west', 'long', 'summer', 'hall', 'bell', 'fisher', 'mason', 'carter', 'cooper', 'parker',
  'walker', 'turner', 'ash', 'rob', 'ow', 'gray', 'drew', 'ed', 'li', 'si', 'cal', 'len']);

// Short forms of first names, so "Dan" is caught for Daniel.
const SHORT = {
  daniel: ['dan', 'danny'], michael: ['mike', 'mick', 'mikey'], richard: ['rich', 'rick', 'richie'], mark: ['marky'], stefan: ['stef'],
  simon: ['si'], kieran: ['kier'], katie: ['kate', 'kat'], katy: ['kate', 'kat'], nicola: ['nicky', 'nic', 'nicki'], jonathan: ['jon', 'jonny'],
  john: ['johnny', 'jon'], james: ['jim', 'jimmy', 'jamie'], jim: ['jimmy'], william: ['will', 'bill', 'billy', 'liam'], liam: ['li'],
  christopher: ['chris'], christine: ['chris'], matthew: ['matt'], thomas: ['tom', 'tommy'], robert: ['rob', 'bob', 'bobby'],
  benjamin: ['ben'], samuel: ['sam'], samantha: ['sam'], alexander: ['alex'], alexandra: ['alex'], douglas: ['doug'], graeme: ['gray'],
  graham: ['gray'], peter: ['pete'], david: ['dave', 'davey'], andrew: ['andy', 'drew'], anthony: ['tony'], joseph: ['joe'],
  stephen: ['steve'], steven: ['steve'], edward: ['ed', 'eddie'], nicholas: ['nick'], callum: ['cal'], leonard: ['leo', 'len'],
  guinevere: ['gwen'], georgia: ['georgie'], zulkarnain: ['zul'], shahrukh: ['shah'], ashwanth: ['ash'], vishal: ['vish'],
  aliriza: ['ali'], charles: ['charlie', 'chas'], ruben: ['rube'], jody: ['jodie'], craig: ['craigy'], owen: ['ow'], taylor: ['tay'],
  karen: ['kaz'], lani: [], deon: [], cobus: ['kobus'], amal: [], mia: [], ruan: [], jacob: ['jake'],
};

// 0 for o, 1 for i and so on, so "sh1t" and "fvck" are read as what they mean.
const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '€': 'e', '£': 'l' };
const leet = (w) => w.replace(/[0134578@$!|€£]/g, (c) => LEET[c] || c);
const squash = (w) => w.replace(/(.)\1+/g, '$1');      // "fuuuuck" -> "fuck", checked alongside the word as written
const stripPlural = (w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w);

const squashedStems = STEMS.map(squash);
const wordSet = new Set([...WORDS, ...WORDS.map(squash)]);

function isRude(token) {
  const forms = new Set([token, squash(token), leet(token), squash(leet(token))]);
  for (const f of forms) {
    if (!f) continue;
    if (STEMS.some((s) => f.startsWith(s)) || squashedStems.some((s) => f.startsWith(s))) return true;
    if (wordSet.has(f) || wordSet.has(stripPlural(f))) return true;
    // "fvck": v standing in for u.
    if (/v/.test(f) && STEMS.some((s) => f.replace(/v/g, 'u').startsWith(s))) return true;
  }
  return false;
}

// Everyone's names, as words to look out for: first names, surnames and full names,
// and the short forms of first names.
export function nameWords(employees) {
  const out = new Map();     // word -> how it's shown back
  for (const e of employees) {
    const parts = String(e.name || '').toLowerCase().replace(/[^a-z' -]/g, ' ').split(/[\s-]+/).filter((p) => p.length > 1);
    for (const p of parts) out.set(p, p);
    for (const s of SHORT[parts[0]] || []) out.set(s, s);
  }
  return out;
}

// Splits text into words with where each one starts, keeping letters, digits and the
// characters people use to dodge filters ("f*ck", "sh!t").
function tokens(text) {
  const out = [];
  const re = /[A-Za-z0-9@$!|*#€£']+/g;
  let m;
  while ((m = re.exec(text))) {
    const raw = m[0].replace(/^'+|'+$/g, '');
    if (raw) out.push({ raw, at: m.index });
  }
  return out;
}

// Whether a word sits at the start of a sentence, where a capital letter means nothing.
function startsSentence(text, at) {
  const before = text.slice(0, at).replace(/\s+$/, '');
  return !before || /[.!?:\n]$/.test(before) || /["'(]$/.test(before);
}

// What's wrong with a piece of text, if anything: each problem word once.
// settings: { blocked: [], allowed: [] } set by admins.
export function check(text, { names = new Map(), blocked = [], allowed = [] } = {}) {
  const s = String(text || '');
  const allow = new Set(allowed.map((w) => String(w).toLowerCase()));
  const extra = new Set(blocked.map((w) => String(w).toLowerCase()));
  const problems = [];
  const seen = new Set();
  const add = (kind, word) => { const k = `${kind}|${word.toLowerCase()}`; if (!seen.has(k)) { seen.add(k); problems.push({ kind, word }); } };

  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(s)) add('contact', s.match(/[\w.+-]+@[\w-]+\.[\w.]+/)[0]);
  if (/(?:\+?\d[\s-]?){9,}/.test(s)) add('contact', 'a phone number');
  for (const m of s.matchAll(/(^|\s)@([A-Za-z][\w.]+)/g)) add('contact', `@${m[2]}`);

  const list = tokens(s);
  // "f u c k": single letters spaced out are read together too.
  for (let i = 0; i < list.length; i++) {
    let j = i, joined = '';
    while (j < list.length && list[j].raw.length === 1) { joined += list[j].raw; j++; }
    if (j - i >= 3 && isRude(joined.toLowerCase())) add('profanity', list.slice(i, j).map((t) => t.raw).join(' '));
  }
  for (let i = 0; i < list.length; i++) {
    const { raw, at } = list[i];
    const lower = raw.toLowerCase();
    if (allow.has(lower)) continue;
    // A word with letters masked out ("f**k", "s#it") is treated as swearing.
    if (/[a-z][*#]+[a-z]?/i.test(raw) || /^[*#]+[a-z]/i.test(raw)) { add('profanity', raw); continue; }
    const plain = lower.replace(/[^a-z0-9@$!|€£]/g, '');
    if (extra.has(lower) || extra.has(plain)) { add('blocked', raw); continue; }
    if (isRude(plain)) { add('profanity', raw); continue; }
    const word = lower.replace(/'s$/, '').replace(/[^a-z']/g, '');
    if (names.has(word)) {
      const capital = /^[A-Z]/.test(raw);
      // Next to another name ("Mark Sherratt"), an everyday word is a name wherever it is.
      const plainOf = (k) => (list[k] ? list[k].raw.toLowerCase().replace(/'s$/, '').replace(/[^a-z']/g, '') : '');
      const besideName = [plainOf(i - 1), plainOf(i + 1)].some((w) => w && names.has(w) && !EVERYDAY.has(w));
      if (EVERYDAY.has(word) && !besideName && !(capital && !startsSentence(s, at))) continue;
      add('name', raw.replace(/'s$/i, ''));
    }
  }
  return problems;
}

// The message shown for a set of problems.
export function explain(problems) {
  if (!problems.length) return null;
  const names = problems.filter((p) => p.kind === 'name').map((p) => p.word);
  const rude = problems.filter((p) => p.kind === 'profanity' || p.kind === 'blocked').map((p) => p.word);
  const contact = problems.filter((p) => p.kind === 'contact').map((p) => p.word);
  const parts = [];
  if (names.length) parts.push(`Leave out names, so nobody is identified: ${names.join(', ')}.`);
  if (rude.length) parts.push(`Leave out swearing and offensive words: ${rude.join(', ')}.`);
  if (contact.length) parts.push(`Leave out email addresses, phone numbers and @mentions: ${contact.join(', ')}.`);
  return parts.join(' ');
}
