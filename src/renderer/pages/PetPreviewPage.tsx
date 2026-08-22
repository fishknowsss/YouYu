import { useMemo, useState } from 'react';
import type { DesktopPetState } from '../../shared/ipc';
import { PetSprite } from '../components/PetSprite';
import { WorkspaceHeader } from '../components/WorkspaceHeader';
import { petStates } from '../pet/atlas';

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
  edgeLeft: '左贴',
  edgeRight: '右贴',
  edgeLeftBlink: '左眨',
  edgeRightBlink: '右眨',
  edgeLeftSleep: '左睡',
  edgeRightSleep: '右睡',
  topSleep: '倒睡',
  bottomSleep: '趴睡',
  bottomDizzy: '晕倒',
  bottomAngry: '生气',
  fallRecover: '落地',
  annoyed: '不悦',
  comfortSad: '低落',
  rewardObserve: '观察'
};

const stateDescriptions: Record<DesktopPetState, string> = {
  idle: '普通停留状态。',
  walkRight: '向右移动。',
  walkLeft: '向左移动。',
  wave: '轻轻挥手。',
  jump: '短暂跳起。',
  liftHold: '被提起时保持拉伸。',
  drag: '拖动时悬空摆动。',
  sleepWake: '困了又醒。',
  focusWait: '安静等待。',
  happy: '开心晃动。',
  edgeLeft: '贴在左侧。',
  edgeRight: '贴在右侧。',
  edgeLeftBlink: '左侧眨眼。',
  edgeRightBlink: '右侧眨眼。',
  edgeLeftSleep: '左侧睡着。',
  edgeRightSleep: '右侧睡着。',
  topSleep: '顶部倒转趴睡。',
  bottomSleep: '贴着底部趴睡。',
  bottomDizzy: '落地后晕一下。',
  bottomAngry: '醒来短暂生气。',
  fallRecover: '落下后恢复。',
  annoyed: '有点不悦。',
  comfortSad: '低落安静。',
  rewardObserve: '观察手里的星星。'
};

export function PetPreviewPage() {
  const [selectedState, setSelectedState] = useState<DesktopPetState>('idle');
  const selectedDescription = useMemo(() => stateDescriptions[selectedState], [selectedState]);

  return (
    <div className="workspace pet-preview-page">
      <WorkspaceHeader title="桌宠预览" description={`共 ${petStates.length} 个状态`} />

      <section className="pet-preview-layout">
        <div className="pet-preview-grid" aria-label="桌宠状态">
          {petStates.map((state) => {
            return (
              <button
                key={state}
                type="button"
                className={`pet-preview-card ${selectedState === state ? 'active' : ''}`}
                aria-label={stateLabels[state]}
                aria-pressed={selectedState === state}
                onClick={() => setSelectedState(state)}
              >
                <span className="pet-preview-stage">
                  <PetSprite state={state} scale={0.4} animated={false} />
                </span>
              </button>
            );
          })}
        </div>

        <aside className="pet-preview-inspector">
          <div className="pet-preview-large">
            <PetSprite state={selectedState} className="pet-preview-main-sprite" />
          </div>
          <div className="pet-preview-detail">
            <h2>{stateLabels[selectedState]}</h2>
            <p>{selectedDescription}</p>
          </div>
        </aside>
      </section>
    </div>
  );
}
