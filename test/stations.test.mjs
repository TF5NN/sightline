import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ASSUMED, parseCsv, readStations, stationBand, stationFrequencies, stationKind, stationLabel, stationLayers } from '../js/stations.js';

const sheet = readFileSync(new URL('../data/stations.csv', import.meta.url), 'utf8');

test('the real stations sheet reads without problems', () => {
  const { stations, problems } = readStations(sheet);
  assert.deepEqual(problems, []);
  assert.ok(stations.length >= 9);
  for (const s of stations) {
    assert.ok(s.lat > 60 && s.lat < 90 && s.lon > -180 && s.lon < 180, `${s.id} position`);
    assert.ok(s.outputMHz > 0, `${s.id} output frequency`);
    assert.ok(s.type, `${s.id} type`);
    assert.ok(s.powerW > 0 && s.heightM >= 0, `${s.id} figures`);
  }
  assert.equal(new Set(stations.map((s) => s.id.toLowerCase())).size, stations.length, 'ids are unique');
});

test('the ÍRA layer holds the nine repeaters, named with their type', () => {
  const { stations } = readStations(sheet);
  const [ira] = stationLayers(stations);
  assert.equal(ira.id, 'ira');
  assert.equal(ira.name, 'ÍRA repeaters');
  assert.equal(ira.stations.length, 9);
  const byId = Object.fromEntries(stations.map((s) => [s.id, s]));
  assert.equal(stationLabel(byId.TF3RPB), 'TF3RPB Bláfjöll · 2 m FM');
  assert.equal(stationLabel(byId.TF3RPI), 'TF3RPI Bláfjöll · 70 cm D-STAR');
  assert.equal(stationLabel(byId.TF3DMR), 'TF3DMR Skeljanes · 70 cm DMR');
  assert.equal(stationLabel(byId.TF3RVK), 'TF3RVK Perlan · 70 cm FM');
  assert.equal(stationFrequencies(byId.TF3RPB), 'Listen 145.650 MHz · transmit 145.050 MHz (−0.6) · tone 88.5');
  assert.equal(stationFrequencies(byId.TF3DMR), 'Listen 439.850 MHz · transmit 434.850 MHz (−5) · code CC1');
  assert.equal(byId.TF3RPK, undefined, 'the repeater that is off the air is not shown');
});

test('figures missing from the sheet are filled in and flagged as assumed', () => {
  const { stations } = readStations(sheet);
  const byId = Object.fromEntries(stations.map((s) => [s.id, s]));
  assert.equal(byId.TF1RPE.powerW, 30);
  assert.deepEqual(byId.TF1RPE.assumed, ['gainDbi', 'heightM']);
  assert.equal(byId.TF1RPE.gainDbi, ASSUMED.gainDbi);
  assert.equal(byId.TF1RPE.heightM, ASSUMED.heightM);
  assert.deepEqual(byId.TF5RPG.assumed, ['powerW', 'gainDbi', 'heightM']);
  assert.equal(byId.TF3RVK.gainDbi, 2);
  assert.deepEqual(byId.TF3RVK.assumed, ['heightM']);
});

test('a station goes to the band nearest its frequency', () => {
  assert.deepEqual(stationBand({ inputMHz: 145.05, outputMHz: 145.65 }), { band: '2m', exact: true, frequency: 145.05 });
  assert.equal(stationBand({ inputMHz: 434.95, outputMHz: 439.95 }).band, '70cm');
  const odd = stationBand({ inputMHz: null, outputMHz: 163.5 });
  assert.equal(odd.exact, false);
  assert.equal(odd.frequency, 163.5);
  assert.equal(stationKind({ outputMHz: 163.5, inputMHz: null, type: 'FM' }), '164 MHz FM');
});

test('a sheet saved by a spreadsheet in Iceland still reads: semicolons, decimal commas, quotes', () => {
  const text = '﻿layer;show;callsign;name;type;output_mhz;lat;lon;height_m;notes\r\nsar;já;Rás 1;"Fell; efra";FM;163,5;64,5;-19,25;12,5;"sagt ""gott"""\r\nsar;no;X;Y;FM;1;1;1;;\r\n';
  assert.equal(parseCsv(text)[1][3], 'Fell; efra');
  const { stations, problems } = readStations(text);
  assert.deepEqual(problems, []);
  assert.equal(stations.length, 1);
  const [s] = stations;
  assert.equal(s.lat, 64.5);
  assert.equal(s.lon, -19.25);
  assert.equal(s.outputMHz, 163.5);
  assert.equal(s.heightM, 12.5);
  assert.equal(s.notes, 'sagt "gott"');
  assert.equal(s.id, 'Rás-1');
  assert.equal(stationLayers(stations)[0].name, 'SAR repeaters');
});

test('a shown station without a position is reported, not shown', () => {
  const { stations, problems } = readStations('layer,show,callsign,name,lat,lon,output_mhz\nira,yes,TF0XX,Nowhere,,,abc\nnew,yes,A1,Here,64,-20,145.5\n');
  assert.equal(stations.length, 1);
  assert.equal(stationLayers(stations)[0].name, 'new');
  assert.equal(problems.length, 1);
  assert.match(problems[0], /TF0XX Nowhere \(line 2\) has no usable position/);
});
