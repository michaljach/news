import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectTopStories, mergeItems, COUNT } from '../src/news.js';

const now = Date.now();

// Builds one story covered by `outlets` publications. The first is the named
// source; the rest are filler that only exist to raise the corroboration score.
function story(items, title, source, outlets, pos) {
  for (let i = 0; i < outlets; i++) {
    items.push({
      title: i === 0 ? title : `${title} reported elsewhere`,
      url: `https://example.test/${encodeURIComponent(title)}/${i}`,
      source: i === 0 ? source : `Filler ${i}`,
      date: now - 3600e3,
      pos: i === 0 ? pos : pos + 50,
    });
  }
}

test('picks are ordered most important first', () => {
  const items = [];
  story(items, 'Alpha alpha alpha unique aardvark', 'Solo', 6, 0);
  story(items, 'Bravo bravo bravo unique bobcat', 'Other', 4, 1);
  story(items, 'Charlie charlie charlie unique cheetah', 'Third', 2, 2);

  const picks = selectTopStories(items);
  assert.ok(picks[0].title.startsWith('Alpha'));
  assert.ok(picks[1].title.startsWith('Bravo'));
  assert.ok(picks[2].title.startsWith('Charlie'));
});

// The per-outlet cap defers a story to a second, relaxed pass. That story can
// outrank one already taken, and used to end up below it.
test('the outlet cap does not push a story below its junior', () => {
  const items = [];
  story(items, 'Alpha alpha alpha unique aardvark', 'Dominant', 6, 0);
  story(items, 'Bravo bravo bravo unique bobcat', 'Dominant', 5, 1);
  story(items, 'Charlie charlie charlie unique cheetah', 'Dominant', 4, 2);
  story(items, 'Delta delta delta unique dolphin', 'Dominant', 3, 3);
  story(items, 'Echo echo echo unique elephant', 'Other', 2, 4);

  const order = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
  const got = selectTopStories(items).map((p) =>
    order.findIndex((prefix) => p.title.startsWith(prefix))
  );

  assert.deepEqual(got, [...got].sort((a, b) => a - b), `out of order: ${got}`);
});

test('the banner story is the highest ranked one', () => {
  const items = [];
  story(items, 'Alpha alpha alpha unique aardvark', 'Dominant', 6, 0);
  story(items, 'Bravo bravo bravo unique bobcat', 'Dominant', 5, 1);
  story(items, 'Charlie charlie charlie unique cheetah', 'Dominant', 4, 2);
  story(items, 'Delta delta delta unique dolphin', 'Other', 2, 3);

  // build.mjs and the Worker both hand picks[0].title to the image step.
  assert.ok(selectTopStories(items)[0].title.startsWith('Alpha'));
});

test('stories survive after dropping out of every feed', () => {
  const yesterday = { title: 'Older story that has left the feeds', url: 'https://example.test/gone', source: 'Wire', date: now - 6 * 3600e3, pos: 0 };
  const merged = mergeItems([yesterday], [{ title: 'Fresh story', url: 'https://example.test/fresh', source: 'Wire', date: now, pos: 0 }]);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((i) => i.url === 'https://example.test/gone'));
});

test('merging the same pull twice does not duplicate', () => {
  const pull = [{ title: 'Only story', url: 'https://example.test/a', source: 'Wire', date: now, pos: 0 }];
  assert.equal(mergeItems(mergeItems([], pull), pull).length, 1);
});

test('first sighting keeps its original publication time', () => {
  const first = { title: 'Story', url: 'https://example.test/a', source: 'Wire', date: now - 7200e3, pos: 0 };
  const relisted = { ...first, date: now };
  assert.equal(mergeItems([first], [relisted])[0].date, first.date);
});

test('no outlet fills more than half the page', () => {
  const items = [];
  for (let i = 0; i < COUNT + 3; i++) {
    story(items, `Story ${'qwertyuiop'[i]} unique ${i}`, 'Hog', COUNT + 3 - i, i);
  }
  story(items, 'Zulu zulu zulu unique zebra', 'Rival', 1, 99);

  const hogs = selectTopStories(items).filter((p) => p.source === 'Hog').length;
  assert.ok(hogs <= Math.ceil(COUNT / 2), `one outlet took ${hogs} of ${COUNT}`);
});
