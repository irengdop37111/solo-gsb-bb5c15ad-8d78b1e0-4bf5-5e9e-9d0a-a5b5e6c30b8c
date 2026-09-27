import { useState } from 'react';
import type { Constraints } from '../types';
import { secondsToSrtTime } from '../lib/srt';
import { FRAME_RATES, type FrameGridResult } from '../lib/frameGrid';

interface FramePanelProps {
  /** 当前字幕条数（0 时面板提示未导入） */
  totalCount: number;
  /** 当前最短时长 / 最小间隔约束（秒，工具栏同源） */
  constraints: Constraints;
  /** 目标帧率 id（24 / 25 / 30 / 30000/1001） */
  rateId: string;
  onRateChange: (id: string) => void;
  /** 联合求解结果；无字幕时为 null */
  result: FrameGridResult | null;
  /** 下载文件名（<原名>.frame.srt），仅作展示 */
  fileName: string;
  /** 有解时下载 .frame.srt（不修改当前字幕与撤销历史） */
  onExport: () => void;
}

/** 毫秒 -> SRT 时间码（00:00:00,000） */
function msToSrt(ms: number): string {
  return secondsToSrtTime(ms / 1000);
}

/**
 * 帧率网格导出面板（停靠在舞台底部）：
 * 把当前字幕的每个起止点吸附到目标帧率网格——每边界取最近帧（等距取较早帧）
 * ±2 帧为候选，在全部字幕的候选边界中联合选择：每条起止至少相隔 1 帧、
 * 毫秒时间码满足当前最短时长 / 最小间隔、起点不早于 0；先最小化全部边界相对
 * 原时间码的绝对误差总和，同分取帧号序列字典序最小者。
 * 无解时显示首个无法接续的字幕及原因（不导出部分结果）；有解时预览原/新
 * 时间码与总误差，确认后下载 .frame.srt——仅生成副本，不改动当前字幕与撤销历史。
 */
export default function FramePanel(p: FramePanelProps) {
  const [collapsed, setCollapsed] = useState(true);
  const result = p.result;

  const summary =
    p.totalCount === 0
      ? '尚未导入字幕'
      : result === null
        ? ''
        : result.ok
          ? `${result.plans.length} 条可对齐 · 总误差 ${result.totalErrorMs.toFixed(1)}ms`
          : `无解：第 ${result.index} 条无法接续`;

  return (
    <section className="frame-dock">
      <div className="frame-head">
        <button
          className="btn mini frame-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? '展开帧率网格导出' : '收起帧率网格导出'}
        >
          {collapsed ? '▸' : '▾'}
        </button>
        <span className="frame-title">🎞 帧率网格导出</span>
        <span className="frame-summary">{summary}</span>
        <div className="frame-rates" title="目标帧率：帧时间按分数（如 30000/1001）直接计算，避免累计漂移">
          <span className="frame-rates-label">目标帧率</span>
          {FRAME_RATES.map((r) => (
            <button
              key={r.id}
              className={['btn mini frame-rate', r.id === p.rateId && 'active'].filter(Boolean).join(' ')}
              onClick={() => p.onRateChange(r.id)}
              title={r.id === '30000/1001' ? '30000/1001 ≈ 29.970 帧/秒' : `${r.label} 帧/秒`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span
          className="frame-constraints"
          title="对齐结果须满足的当前约束（工具栏同源，随调整实时重算）"
        >
          最短时长 {p.constraints.minDuration.toFixed(2)}s · 最小间隔 {p.constraints.minGap.toFixed(2)}s
        </span>
      </div>

      {!collapsed && p.totalCount > 0 && result !== null && (
        <div className="frame-body">
          {result.ok ? (
            <>
              <div className="frame-stats">
                <span>
                  总误差 <strong>{result.totalErrorMs.toFixed(3)}ms</strong>
                </span>
                <span>
                  单边界最大误差 <strong>{result.maxErrorMs.toFixed(3)}ms</strong>
                </span>
                <span className="frame-stats-dim">
                  帧时间按 {result.rate.num}/{result.rate.den} 分数计算并四舍五入到毫秒
                </span>
                <button
                  className="btn primary mini frame-export"
                  onClick={p.onExport}
                  title={`下载 ${p.fileName}（仅生成副本，不修改当前字幕与撤销历史）`}
                >
                  下载 .frame.srt
                </button>
              </div>
              <div className="frame-list">
                {result.plans.map((pl) => (
                  <div key={pl.cueId} className="frame-row">
                    <span className="frame-idx">#{pl.index}</span>
                    <span className="frame-time">
                      {msToSrt(pl.oldStartMs)} → {msToSrt(pl.oldEndMs)}
                    </span>
                    <span className="frame-arrow">⇒</span>
                    <span className="frame-time new">
                      {msToSrt(pl.newStartMs)} → {msToSrt(pl.newEndMs)}
                    </span>
                    <span className="frame-frames">
                      帧 {pl.startFrame} → {pl.endFrame}
                    </span>
                  </div>
                ))}
              </div>
              <div className="frame-note">
                预览为「原时间码 ⇒ 帧网格时间码」；下载 {p.fileName} 只生成对齐副本，当前字幕与撤销历史不变。
              </div>
            </>
          ) : (
            <div className="frame-fail">
              <span className="frame-fail-title">
                ✕ 第 #{result.index} 条无法接续，未导出任何结果
              </span>
              <span className="frame-fail-reason">{result.reason}</span>
              <span className="frame-fail-hint">
                可调整最短时长 / 最小间隔约束或更换目标帧率后重试；无解时不导出部分结果。
              </span>
            </div>
          )}
        </div>
      )}
      {!collapsed && p.totalCount === 0 && (
        <div className="frame-body">
          <div className="frame-empty">导入 SRT 后，这里会把全部字幕起止点对齐到所选帧率网格并生成 .frame.srt 下载。</div>
        </div>
      )}
    </section>
  );
}
