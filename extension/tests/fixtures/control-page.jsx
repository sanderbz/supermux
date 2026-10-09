import React, {useState} from '../../../web/node_modules/react/index.js';
import {createRoot} from '../../../web/node_modules/react-dom/client.js';
function App() {
  const [name,setName]=useState(''),[clicks,setClicks]=useState(0);
  return <main><header><span className="eyebrow">EXAMPLE WORKSPACE</span><h1>Release checklist</h1><p>Prepare the next release.</p></header><section><h2>Release details</h2><label>Release name<input aria-label="Release name" id="name" value={name} onChange={e=>{window.inputTrusted=e.nativeEvent.isTrusted;setName(e.target.value);}} /></label><output id="name-state">{name||'Untitled release'}</output><button id="approve" onClick={e=>{window.clickTrusted=e.nativeEvent.isTrusted;setClicks(n=>n+1);}}>Approve release</button><output id="click-count">{clicks}</output><label>Channel<select id="channel" aria-label="Channel"><option>Preview</option><option>Stable</option></select></label><div id="editable" contentEditable suppressContentEditableWarning role="textbox" aria-label="Release notes">Draft notes</div><canvas id="canvas" width="280" height="50" aria-label="Canvas action" onDoubleClick={e=>{window.canvasTrusted=e.nativeEvent.isTrusted;window.canvasDouble=true;}} /><iframe title="Embedded checklist" src="/frame" /></section></main>;
}
createRoot(document.getElementById('app')).render(<App/>);
