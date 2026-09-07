import { WorldView } from './world-view.js';
import { ModelLibrary } from './model-library.js';
import { resolveQualityProfile } from './quality.js';
import { GRAPHICS_OPTIONS, readGraphicsSettings, commitGraphicsSettings } from './graphics-settings.js';
import { installGraphicsRuntime } from './graphics-runtime.js';
import { createWanderer, styleWastelandAsset } from './wasteland-models.js';

const quality = resolveQualityProfile();
installGraphicsRuntime(WorldView, ModelLibrary, quality, {
  createWanderer, styleAsset: styleWastelandAsset,
});

const labels = {
  preset: ['画質プリセット', ['自動', '軽量', '標準', '高画質', '最高画質']],
  resolution: ['描画解像度の上限', ['プリセットに従う', '0.75倍', '1倍', '1.5倍', '2倍']],
  shadows: ['影', ['プリセットに従う', 'なし', '軽量（512）', '標準（1024）', '高精細（2048）']],
  water: ['水面', ['プリセットに従う', '簡易・静止', '波紋・反射色']],
  vegetation: ['草・小物の密度', ['プリセットに従う', 'なし', '少なめ', '多め']],
  fps: ['最大フレームレート', ['プリセットに従う', '30 fps', '60 fps']],
};

export function mountGraphicsControls(document) {
  const panel = document.querySelector('#settings-panel');
  if (!panel || document.querySelector('#graphics-settings')) return;
  const style = document.createElement('style');
  style.textContent = `
    #settings-panel { max-height:calc(100dvh - 100px); overflow-y:auto; overscroll-behavior:contain; }
    #graphics-settings { margin:12px 0 18px; border:0; border-bottom:1px solid #ffffff30; padding:0 0 18px; min-width:0; }
    #graphics-settings legend { font-size:16px; font-weight:700; margin-bottom:8px; }
    #graphics-settings label { display:flex; flex-direction:column; gap:5px; margin:10px 0; }
    #graphics-settings select { min-height:40px; width:100%; }
    #graphics-settings details { margin:12px 0; }
    #graphics-settings summary { cursor:pointer; min-height:32px; }
    #graphics-settings button { min-height:44px; margin:4px 4px 0 0; }
    #graphics-settings-message { min-height:1.5em; font-size:12px; }
    @media(max-width:680px) { #settings-panel { max-width:calc(100vw - 24px); max-height:calc(100dvh - 88px); } }
  `;
  document.head.append(style);
  const fieldset = document.createElement('fieldset');
  fieldset.id = 'graphics-settings';
  const legend = document.createElement('legend'); legend.textContent = 'グラフィック設定';
  fieldset.append(legend);
  const note = document.createElement('p'); note.className = 'settings-note';
  note.textContent = `現在: ${quality.label} / 最大${quality.frameRate} fps。設定はこのブラウザーに保存します。軽量は外部モデル・環境反射・草を省略します。`;
  fieldset.append(note);
  const values = readGraphicsSettings();
  const selectors = {};
  const details = document.createElement('details');
  const summary = document.createElement('summary'); summary.textContent = '個別設定'; details.append(summary);
  for (const [key, choices] of Object.entries(GRAPHICS_OPTIONS)) {
    const label = document.createElement('label'); label.htmlFor = `graphics-${key}`;
    label.append(document.createTextNode(labels[key][0]));
    const select = document.createElement('select'); select.id = label.htmlFor;
    choices.forEach((value, index) => {
      const option = document.createElement('option'); option.value = value;
      option.textContent = labels[key][1][index]; select.append(option);
    });
    select.value = values[key]; selectors[key] = select; label.append(select);
    (key === 'preset' ? fieldset : details).append(label);
  }
  const updateAvailability = () => { selectors.vegetation.disabled = selectors.preset.value === 'low'; };
  selectors.preset.addEventListener('change', () => {
    for (const [key, select] of Object.entries(selectors)) if (key !== 'preset') select.value = 'auto';
    updateAvailability();
  });
  updateAvailability(); fieldset.append(details);
  const hint = document.createElement('p'); hint.className = 'settings-note';
  hint.textContent = '保存して適用すると再読み込みします。解像度はCSSピクセル比の上限です。URLの画質指定は適用時に解除し、Region指定は保持します。';
  fieldset.append(hint);
  const message = document.createElement('p'); message.id = 'graphics-settings-message';
  message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  for (const [text, reset] of [['保存して適用', false], ['初期設定に戻す', true]]) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
    button.addEventListener('click', () => {
      const settings = Object.fromEntries(Object.entries(selectors).map(([key, select]) => [key, select.value]));
      const ok = commitGraphicsSettings(settings, { href: location.href, reset,
        navigate: url => location.assign(url) });
      if (!ok) message.textContent = '設定を保存できませんでした。ブラウザーのストレージ許可・空き容量を確認してください。現在の設定は変更していません。';
    });
    fieldset.append(button);
  }
  fieldset.append(message);
  panel.insertBefore(fieldset, panel.children[1] || null);
  document.querySelector('#settings-button')?.setAttribute('aria-label', 'グラフィック・接続設定');
}

if (globalThis.document) mountGraphicsControls(document);
