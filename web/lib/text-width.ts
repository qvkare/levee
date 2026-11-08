/**
 * Text widths for the drawings, worked out the same way on the server and in the browser, so a
 * label box fits its text before any script runs. Advance widths are per mille of the em, read from
 * the self-hosted Overpass (app/fonts) at each weight with fontTools' instancer. Kerning is left out,
 * so callers leave a few pixels spare. Overpass Mono advances 0.616 em at every weight.
 */
const CHARS = "0123456789 !\"#$%&'()*+,-./:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~·…’×–";

const TABLES: Record<Weight, string> = {
  400: "642,373,612,602,621,621,597,522,611,597,235,273,403,683,588,870,677,214,343,343,533,645,225,399,225,490,225,225,645,645,645,514,809,679,656,647,682,599,562,688,700,283,546,660,559,804,708,730,630,730,665,599,583,689,652,840,603,641,650,376,490,376,645,490,368,526,562,500,562,538,333,563,563,254,254,531,262,847,563,558,565,563,389,469,378,563,512,715,517,529,505,372,272,372,645,225,941,225,645,510",
  600: "653,391,612,601,636,614,609,532,623,609,245,291,430,696,599,858,700,235,363,363,546,639,241,410,237,511,237,237,639,639,639,511,826,704,679,642,701,616,571,684,714,292,554,692,564,808,715,725,636,725,682,609,596,704,672,845,653,670,643,387,511,387,639,494,433,547,572,528,572,551,352,573,582,273,273,550,281,866,582,564,574,573,408,485,388,582,543,737,557,555,531,380,291,380,639,237,1018,241,639,504",
  700: "658,400,612,600,643,611,615,537,629,615,250,300,443,702,604,852,711,245,373,373,552,636,249,415,243,523,243,243,636,636,636,510,834,717,690,639,710,624,575,682,721,296,558,708,566,810,718,722,639,723,690,614,602,712,682,848,678,684,639,393,523,393,636,496,466,557,577,542,577,557,362,578,592,283,283,559,291,876,592,567,578,578,417,493,393,592,558,748,577,568,544,384,301,384,636,243,1056,249,636,501",
  800: "663,409,611,599,650,608,620,541,635,620,255,309,456,709,609,845,722,256,382,382,559,633,257,420,249,533,249,249,633,633,633,509,843,730,702,636,720,633,579,679,728,300,561,724,569,811,722,720,641,721,698,618,609,720,692,851,703,698,636,399,533,399,633,498,499,568,582,555,582,564,372,582,602,293,293,569,301,886,602,569,583,582,426,500,397,602,573,759,597,581,556,387,311,387,633,249,1095,257,633,498",
};

export type Weight = 400 | 600 | 700 | 800;

const MAPS = Object.fromEntries(
  (Object.keys(TABLES) as unknown as Weight[]).map((weight) => {
    const values = TABLES[weight].split(",").map(Number);
    return [weight, new Map([...CHARS].map((char, index) => [char, (values[index] ?? 600) / 1000]))];
  }),
) as Record<Weight, Map<string, number>>;

const MONO_ADVANCE = 0.616;

/** Width in pixels of `text` set at `size` pixels. An unknown character counts as 0.6 em. */
export function textWidth(text: string, size: number, weight: Weight = 600, mono = false): number {
  if (mono) return [...text].length * MONO_ADVANCE * size;
  const map = MAPS[weight];
  let em = 0;
  for (const char of text) em += map.get(char) ?? 0.6;
  return em * size;
}
