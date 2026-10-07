import assert from 'node:assert/strict';

// A correctly positioned SVG/pin can coexist with a still-transforming editor.
// Accept the editor only after its finite entrance animation has finished.
export function assertEditorGeometry(state,{number,labelContains,x,y,label}){
  assert.ok(state.pins.some(pin=>pin.number===number&&pin.selected&&pin.visible),`${label}: DOM note stays selected`);
  assert.ok(state.editor?.label.includes(labelContains),`${label}: correct editor label`);
  assert.equal(state.editor.animating,false,`${label}: editor entrance animation finished`);
  for(const [axis,expected] of [['x',x],['y',y]])assert.ok(Math.abs(state.editor[axis]-expected)<=1.5,`${label} ${axis}: expected ${expected}, got ${state.editor[axis]}`);
}
