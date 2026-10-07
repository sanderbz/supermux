import test from 'node:test';
import assert from 'node:assert/strict';
import {assertEditorGeometry} from './helpers/geometry.mjs';

test('editor geometry rejects animation frames and persistent placement errors at the original tolerance',()=>{
 const expected={number:2,labelContains:'Nested scroll target',x:380,y:284,label:'selected nested editor'};
 const frame=(x,y,animating)=>({pins:[{number:2,selected:true,visible:true}],editor:{label:'Nested scroll target',x,y,animating}});
 // The observed failure is a card-scale offset. Even a later animation frame
 // inside the tolerance must not become the accepted settled position.
 for(const state of [frame(382.208129,284,true),frame(380.75,284.5,true),frame(380,284,true)])assert.throws(()=>assertEditorGeometry(state,expected),/animation finished/);
 assert.doesNotThrow(()=>assertEditorGeometry(frame(380,284,false),expected));
 assert.throws(()=>assertEditorGeometry(frame(382.208129,284,false),expected),/x: expected 380/);
 assert.throws(()=>assertEditorGeometry(frame(380,286,false),expected),/y: expected 284/);
 const changed=frame(380,284,false);changed.pins[0].selected=false;assert.throws(()=>assertEditorGeometry(changed,expected),/stays selected/);
 const wrong=frame(380,284,false);wrong.editor.label='Another element';assert.throws(()=>assertEditorGeometry(wrong,expected),/correct editor label/);
});
