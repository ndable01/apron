'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Docs = require('../assets/documents.js');
const batch = 'batch-test-documents';

test('text files are kept as blobs with a normalized, non-executable type', async () => {
  const file = new File(['<html>ordinary attachment text</html>'], 'report.txt', { type: 'text/html' });
  const record = await Docs.prepare(file, batch, 'quality');
  assert.equal(record.type, 'text/plain');
  assert.equal(record.blob.type, 'text/plain');
  assert.equal(record.size, file.size);
  assert.equal(await record.blob.text(), await file.text());
  assert.equal(record.category, 'quality');
  Docs.validateSet(batch, [record]);
});
test('real JPEG content passes and forged image extensions do not', async () => {
  const data = fs.readFileSync('assets/test-tomato.jpg');
  const record = await Docs.prepare(new File([data], 'label.JPG'), batch, 'labels');
  assert.equal(record.type, 'image/jpeg');
  assert.deepEqual(Buffer.from(await record.blob.arrayBuffer()), data);
  await assert.rejects(Docs.prepare(new File(['<script>text</script>'], 'fake.jpg'), batch, 'labels'), /не совпадает/);
});
test('PDF and Office containers have their signatures checked', async () => {
  const pdf = await Docs.prepare(new File(['%PDF-1.7\nheader fixture'], 'passport.pdf'), batch, 'quality');
  assert.equal(pdf.type, 'application/pdf');
  const word = await Docs.prepare(new File([Buffer.from([80, 75, 3, 4, 0])], 'declaration.docx'), batch, 'declaration');
  assert.match(word.type, /wordprocessingml/);
  await assert.rejects(Docs.prepare(new File(['not a PDF'], 'fake.pdf'), batch, 'lab'), /не совпадает/);
});
test('empty, oversized and unsupported files fail before being stored', async () => {
  await assert.rejects(Docs.prepare(new File([], 'empty.txt'), batch, 'lab'), /пустой/);
  await assert.rejects(Docs.prepare({ name: 'big.pdf', size: Docs.MAX_SIZE + 1 }, batch, 'lab'), /больше 20/);
  for (const name of ['page.html', 'drawing.svg', 'program.exe', 'no-extension']) {
    await assert.rejects(Docs.prepare(new File(['content'], name), batch, 'lab'), /формат/);
  }
});
test('attachments are scoped to a batch and known checklist items', async () => {
  const record = await Docs.prepare(new File(['text'], 'doc.txt'), batch, 'shipment');
  assert.throws(() => Docs.validateSet('batch-other', [record]), /Некорректный/);
  await assert.rejects(Docs.prepare(new File(['text'], 'doc.txt'), batch, 'unknown'), /чек-листа/);
  assert.throws(() => Docs.validateSet(batch, [record, record]), /Некорректный/);
});
test('limits count per checklist item and replacement can retain the same count', async () => {
  const records = await Promise.all(Array.from({ length: 11 }, (_, i) => Docs.prepare(new File(['' + i], i + '.txt'), batch, 'shipment')));
  Docs.validateSet(batch, records.slice(0, 10));
  assert.throws(() => Docs.validateSet(batch, records), /до 10/);
  Docs.validateSet(batch, records.slice(1));
});
test('download filenames are bounded and stripped of path separators', async () => {
  const r = await Docs.prepare(new File(['text'], '../folder/' + 'a'.repeat(200) + '.txt'), batch, 'quality');
  assert.ok(r.name.length <= 180); assert.ok(r.name.endsWith('.txt')); assert.doesNotMatch(r.name, /[\\/]/);
});
test('a denied storage API reports a failure and allows retry', async () => {
  if (typeof indexedDB !== 'undefined') return;
  await assert.rejects(Docs.list(batch), /хранение файлов недоступно/);
  await assert.rejects(Docs.list(batch), /хранение файлов недоступно/);
});
