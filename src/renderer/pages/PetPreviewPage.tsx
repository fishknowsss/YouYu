import { useMemo, useState } from 'react';
import type { DesktopPetState } from '../../shared/ipc';
import { PetSprite } from '../components/PetSprite';
import { getPetAnimation, petStates } from '../pet/atlas';

const stateLabels: Record<DesktopPetState, string> = {
  idle: '待机',
  walkRight: '右移',
  walkLeft: '左移',
  wave: '挥手',
  jump: '跳起',
  liftHold: '提起',
  drag: '拖拽',
  sleepWake: '困醒',
  focusWait: '等待',
  happy: '开心',
  edgePeek: '探边',
  edgeLeft: '左贴',
  edgeRight: '右贴',
  fallRecover: '落地',
  annoyed: '不悦',
  comfortSad: '低落',
  rewardObserve: '观察'
};

export function PetPreviewPage() {
  const [selectedState, setSelectedState] = useState<DesktopPetState>('idle');
  const selectedAnimation = useMemo(() => getPetAnimation(selectedState), [selectedState]);
  const loopText = selectedAnimation.loop ? '循环' : '单次';
  const atlasText = selectedAnimation.atlas === 'main' ? '主图集' : '扩展图集';

  return (
    <div className="workspace pet-preview-page">
      <div className="workspace-header">
        <div>
          <h1>桌宠预览</h1>
          <p>共 {petStates.length} 个状态</p>
        </div>
        <div className="pet-preview-summary">
          <span>{atlasText}</span>
          <strong>{stateLabels[selectedState]}</strong>
        </div>
      </div>

      <section className="pet-preview-layout">
        <div className="pet-preview-grid" aria-label="桌宠状态">
          {petStates.map((state) => {
            const animation = getPetAnimation(state);
            return (
              <button
                key={state}
                type="button"
                className={`pet-preview-card ${selectedState === state ? 'active' : ''}`}
                onClick={() => setSelectedState(state)}
              >
                <span className="pet-preview-stage">
                  <PetSprite state={state} scale={0.46} />
                </span>
                <span className="pet-preview-name">{stateLabels[state]}</span>
                <span className="pet-preview-meta">
                  {animation.atlas} · {animation.frameIndexes.length} 帧
                </span>
              </button>
            );
          })}
        </div>

        <aside className="pet-preview-inspector">
          <div className="pet-preview-large">
            <PetSprite state={selectedState} />
          </div>
          <div className="pet-preview-detail">
            <h2>{stateLabels[selectedState]}</h2>
            <dl>
              <div>
                <dt>状态</dt>
                <dd>{selectedState}</dd>
              </div>
              <div>
                <dt>图集</dt>
                <dd>{selectedAnimation.atlas}</dd>
              </div>
              <div>
                <dt>行号</dt>
                <dd>{selectedAnimation.row}</dd>
              </div>
              <div>
                <dt>帧数</dt>
                <dd>{selectedAnimation.frameIndexes.length}</dd>
              </div>
              <div>
                <dt>帧率</dt>
                <dd>{selectedAnimation.fps} fps</dd>
              </div>
              <div>
                <dt>播放</dt>
                <dd>{loopText}</dd>
              </div>
            </dl>
          </div>
        </aside>
      </section>
    </div>
  );
}
