/**
 * Suggesting a name for a new Fellow (docs/agents/SPEC.md section 5.1).
 *
 * The name shares its first letter with the home domain: Ada works astronomy, Bruno works
 * biomedicine. Nothing enforces it and nothing depends on it - it is a reading aid, so that a
 * roster of a dozen Fellows can be scanned without matching each name to its subject first.
 *
 * A domain may hold several Fellows at once, and several domains share a letter (four of this
 * vault's start with "c"), so the suggestion is a list per letter rather than one name, and
 * skips what is taken. A name only ever fills the field: the user may write anything.
 */

/**
 * Common English first names by initial, alternating so a roster does not come out all men or
 * all women. Ordinary names on purpose: a Fellow is a colleague in a list, not a character.
 */
const BY_LETTER: Readonly<Record<string, readonly string[]>> = {
  a: ['Ada', 'Alan', 'Amara', 'Arthur', 'Alice', 'Adrian', 'Astrid', 'August'],
  b: ['Beatrice', 'Bruno', 'Bridget', 'Basil', 'Bianca', 'Bennett', 'Blythe', 'Boris'],
  c: ['Clara', 'Casper', 'Cecilia', 'Callum', 'Colette', 'Cyrus', 'Camille', 'Conrad'],
  d: ['Delia', 'Desmond', 'Dorothy', 'Damien', 'Dana', 'Dexter', 'Daphne', 'Duncan'],
  e: ['Edith', 'Elias', 'Esme', 'Everett', 'Eleanor', 'Emrys', 'Elodie', 'Ezra'],
  f: ['Fiona', 'Felix', 'Freya', 'Fabian', 'Florence', 'Finlay', 'Frida', 'Forrest'],
  g: ['Greta', 'Gideon', 'Genevieve', 'Grant', 'Giselle', 'Gareth', 'Georgia', 'Gustav'],
  h: ['Hazel', 'Hugo', 'Harriet', 'Hector', 'Helena', 'Hamish', 'Honora', 'Hollis'],
  i: ['Iris', 'Ivan', 'Imogen', 'Isaac', 'Ingrid', 'Ignatius', 'Isla', 'Ilya'],
  j: ['Juno', 'Julian', 'Josephine', 'Jasper', 'Jocelyn', 'Jonah', 'Judith', 'Jules'],
  k: ['Kira', 'Kelvin', 'Katherine', 'Kaspar', 'Kendra', 'Killian', 'Kyra', 'Konrad'],
  l: ['Lena', 'Linus', 'Lucia', 'Lawrence', 'Lydia', 'Leopold', 'Luna', 'Lachlan'],
  m: ['Mira', 'Milo', 'Margaret', 'Marcus', 'Maeve', 'Malcolm', 'Matilda', 'Mortimer'],
  n: ['Nadia', 'Nolan', 'Noor', 'Nathaniel', 'Nell', 'Nikolai', 'Nadine', 'Norman'],
  o: ['Odette', 'Oscar', 'Olivia', 'Otto', 'Ophelia', 'Owen', 'Oona', 'Orson'],
  p: ['Petra', 'Piers', 'Priya', 'Percival', 'Paloma', 'Peregrine', 'Phoebe', 'Pascal'],
  q: ['Quinn', 'Quentin', 'Querida', 'Quill', 'Quintessa', 'Quincy', 'Quinta', 'Quade'],
  r: ['Rosa', 'Rupert', 'Rowena', 'Reuben', 'Romy', 'Roland', 'Ruth', 'Rafael'],
  s: ['Sylvia', 'Silas', 'Saoirse', 'Sebastian', 'Selma', 'Sander', 'Sofia', 'Stellan'],
  t: ['Thea', 'Tobias', 'Tamsin', 'Theodore', 'Talia', 'Tristan', 'Tabitha', 'Trevor'],
  u: ['Ursula', 'Ulric', 'Una', 'Ulysses', 'Ulla', 'Urban', 'Umbria', 'Uziel'],
  v: ['Vera', 'Viggo', 'Verity', 'Vincent', 'Viola', 'Vaughn', 'Valentina', 'Victor'],
  w: ['Wren', 'Walter', 'Willa', 'Wendell', 'Winifred', 'Wilhelm', 'Wanda', 'Wyatt'],
  x: ['Xenia', 'Xavier', 'Ximena', 'Xander', 'Xiomara', 'Xerxes', 'Xola', 'Xavi'],
  y: ['Yara', 'Yusuf', 'Yvonne', 'Yannick', 'Yolanda', 'Yorick', 'Yuki', 'Yves'],
  z: ['Zora', 'Zeno', 'Zelda', 'Zachary', 'Zaida', 'Zephyr', 'Zinnia', 'Zane'],
}

/** Anything already spoken for: existing Fellows, retired ones included, compared loosely. */
const norm = (name: string): string => name.trim().toLowerCase()

/**
 * A name for a Fellow of `domain` that nobody carries yet, or `''` when there is nothing to
 * suggest (no domain chosen).
 *
 * Falls through in three steps: an unused name on the domain's own letter, then a numbered
 * one on that letter once all eight are out, then - for a domain whose letter has no list at
 * all - the alphabet from the start, so the field is never left empty by an unusual key.
 */
export function suggestFellowName(domain: string, taken: readonly string[] = []): string {
  const key = domain.trim().toLowerCase()
  if (key === '') return ''
  const used = new Set(taken.map(norm))
  const letter = key[0]!
  const names = BY_LETTER[letter] ?? Object.values(BY_LETTER).flat()
  const free = names.find((n) => !used.has(norm(n)))
  if (free !== undefined) return free
  // Every name on this letter is taken: keep the letter and number it, which reads as the
  // second Ada rather than as a stranger who happens to work astronomy.
  const first = names[0]!
  for (let i = 2; i < 100; i++) {
    if (!used.has(norm(`${first} ${i}`))) return `${first} ${i}`
  }
  return first
}
