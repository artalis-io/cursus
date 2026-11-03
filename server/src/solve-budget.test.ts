import {test} from 'node:test';
import assert from 'node:assert/strict';
import {solveBudget} from './solve-budget.js';
test('solve budgets admit presets and preserve short integration budgets',()=>{
 for(const seconds of [1,30,60,240,600])assert.equal(solveBudget(seconds,240,600),seconds);
 assert.equal(solveBudget(undefined,240,600),240);
 assert.equal(solveBudget(undefined,240,30),30);
});
test('API admission rejects malformed and over-limit budgets before queueing',()=>{
 for(const seconds of [null,'600',true,{},[],NaN,Infinity,-1,0,1.5,601,86400])assert.throws(()=>solveBudget(seconds,240,600));
});
test('native execution also caps previously admitted work against current operator limits',()=>{
 assert.equal(solveBudget(600,240,30,true),30);
 assert.throws(()=>solveBudget(Infinity,240,600,true));
});
