import test from 'node:test';
import assert from 'node:assert/strict';
import {cycleWindow,dueCycles,dateUTC} from '../cycles.js';
test('janela de 60 dias e antecipação de 15',()=>{assert.deepEqual(cycleWindow('2026-11-01',0),{index:0,start:'2026-11-01',end:'2026-12-30',generateOn:'2026-10-17'});assert.equal(cycleWindow('2026-11-01',1).start,'2026-12-31')});
test('preparação não duplica ciclos',()=>{const first=dueCycles('2026-11-01','2026-10-17');assert.equal(first.length,1);assert.equal(dueCycles('2026-11-01','2026-10-17',first).length,0)});
test('datas inválidas são rejeitadas',()=>assert.throws(()=>dateUTC('2026-02-30')));
