/**
 * 帧率网格导出：把当前字幕的每个起止点吸附到目标帧率网格上（纯函数，可单测）。
 *
 * - 目标帧率以分数表示（num/den 帧每秒，如 30000/1001）；帧 k 的时间恒按
 *   k × den / num 直接计算，不做累加，避免累计漂移。
 * - 每个边界取「最近帧（等距取较早帧）及前后各 2 帧」共至多 5 个候选，
 *   负帧号剔除（起点不早于 0）。
 * - 在全部字幕的候选边界中联合选择：每条起止至少相隔 1 帧；按帧时间四舍五入
 *   到毫秒的输出时间码须满足当前最短时长 / 最小间隔约束。
 * - 目标：先最小化全部边界相对原时间码（毫秒）的绝对误差总和，同分取按字幕
 *   顺序排列的帧号序列字典序最小者。误差以 1/num 毫秒为单位的整数精确累计
 *   （k·den·1000 与 tMs·num 均远小于 2^53），并列判定不含浮点误差。
 * - 求解：按时间序做动态规划（前向最小代价 + 后向最优后缀），再用后缀代价
 *   从字典序最小的可行前缀逐位贪心重建；无解时报告首个无法接续的字幕及原因，
 *   不产生任何部分结果。导出只生成下载副本，不修改原字幕与撤销历史。
 */

import type { Constraints, Cue } from '../types';
import { serializeSrt } from './srt';

/** 目标帧率（分数形式：num / den 帧每秒） */
export interface FrameRate {
  id: string;
  /** 界面展示用简称 */
  label: string;
  num: number;
  den: number;
}

/** 可选目标帧率：24 / 25 / 30 / 30000/1001（≈29.97） */
export const FRAME_RATES: FrameRate[] = [
  { id: '24', label: '24', num: 24, den: 1 },
  { id: '25', label: '25', num: 25, den: 1 },
  { id: '30', label: '30', num: 30, den: 1 },
  { id: '30000/1001', label: '29.97', num: 30000, den: 1001 }
];

/** 按 id 取帧率；未知 id 回退到第一项 */
export function frameRateById(id: string): FrameRate {
  return FRAME_RATES.find((r) => r.id === id) ?? FRAME_RATES[0];
}

/** 帧 k 的时间（秒）：恒按 k × den / num 直接计算，避免累计漂移 */
export function frameTimeSeconds(rate: FrameRate, k: number): number {
  return (k * rate.den) / rate.num;
}

/** 帧 k 的时间四舍五入到毫秒（输出毫秒时间码用） */
export function frameTimeMs(rate: FrameRate, k: number): number {
  return Math.round((k * rate.den * 1000) / rate.num);
}

/** 时间 t（秒）的最近帧；恰好等距时取较早帧 */
export function nearestFrame(rate: FrameRate, t: number): number {
  const x = (t * rate.num) / rate.den;
  return Math.ceil(x - 0.5);
}

/** 候选帧号：最近帧及前后各 2 帧（升序），剔除负帧号 */
export function frameCandidates(rate: FrameRate, t: number): number[] {
  const n = nearestFrame(rate, t);
  const out: number[] = [];
  for (let k = n - 2; k <= n + 2; k += 1) {
    if (k >= 0) out.push(k);
  }
  return out;
}

/**
 * 单边界绝对误差，以 1/num 毫秒为单位的整数（精确，无浮点累计）：
 * |k·den·1000 − tMs·num|；真实毫秒误差 = 该值 / num。
 */
function errorUnits(rate: FrameRate, k: number, tMs: number): number {
  return Math.abs(k * rate.den * 1000 - tMs * rate.num);
}

/** 单条字幕的帧对齐结果 */
export interface FrameGridCuePlan {
  cueId: string;
  /** 列表序号（1-based，时间序） */
  index: number;
  startFrame: number;
  endFrame: number;
  /** 原时间码（毫秒，四舍五入） */
  oldStartMs: number;
  oldEndMs: number;
  /** 新时间码：帧时间四舍五入到毫秒 */
  newStartMs: number;
  newEndMs: number;
}

export interface FrameGridSuccess {
  ok: true;
  rate: FrameRate;
  /** 时间序的逐条结果 */
  plans: FrameGridCuePlan[];
  /** 全部边界相对原时间码的绝对误差总和（毫秒） */
  totalErrorMs: number;
  /** 单边界最大绝对误差（毫秒） */
  maxErrorMs: number;
}

export type FrameGridFailKind = 'min-duration' | 'min-gap';

export interface FrameGridFailure {
  ok: false;
  rate: FrameRate;
  kind: FrameGridFailKind;
  /** 首个无法接续的字幕 */
  cueId: string;
  /** 列表序号（1-based，时间序） */
  index: number;
  /** 具体原因（不含序号前缀） */
  reason: string;
}

export type FrameGridResult = FrameGridSuccess | FrameGridFailure;

/**
 * 联合求解全部字幕的帧对齐方案。返回 null 仅表示没有字幕。
 * 无解时给出按时间序首个无法接续的字幕及原因，不返回部分结果。
 */
export function planFrameGrid(
  cues: Cue[],
  constraints: Constraints,
  rate: FrameRate
): FrameGridResult | null {
  if (cues.length === 0) return null;
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  const n = sorted.length;
  const EPS = 1e-6;
  const minDurMs = constraints.minDuration * 1000;
  const minGapMs = constraints.minGap * 1000;

  const startMs = sorted.map((c) => Math.round(c.start * 1000));
  const endMs = sorted.map((c) => Math.round(c.end * 1000));
  const startCand = sorted.map((c) => frameCandidates(rate, c.start));
  const endCand = sorted.map((c) => frameCandidates(rate, c.end));
  const startCandMs = startCand.map((list) => list.map((k) => frameTimeMs(rate, k)));
  const endCandMs = endCand.map((list) => list.map((k) => frameTimeMs(rate, k)));

  const INF = Number.POSITIVE_INFINITY;

  // 每条字幕的合法 (起点槽, 终点槽) 代价矩阵：起止至少相隔 1 帧，
  // 且四舍五入到毫秒的时长满足最短时长；不合法为 Infinity。
  // 候选帧升序，槽位下标即帧号大小顺序，供字典序贪心使用。
  const pairCost: number[][][] = [];
  for (let i = 0; i < n; i += 1) {
    const matrix: number[][] = startCand[i].map(() => endCand[i].map(() => INF));
    for (let ss = 0; ss < startCand[i].length; ss += 1) {
      for (let es = 0; es < endCand[i].length; es += 1) {
        const sf = startCand[i][ss];
        const ef = endCand[i][es];
        if (ef < sf + 1) continue; // 起止至少相隔 1 帧
        const durMs = endCandMs[i][es] - startCandMs[i][ss];
        if (durMs < minDurMs - EPS) continue;
        matrix[ss][es] =
          errorUnits(rate, sf, startMs[i]) + errorUnits(rate, ef, endMs[i]);
      }
    }
    pairCost.push(matrix);
  }

  const gapMsOk = (prevEndMs: number, curStartMs: number): boolean =>
    curStartMs - prevEndMs >= minGapMs - EPS;
  const hasPair = (i: number): boolean =>
    pairCost[i].some((row) => row.some((v) => Number.isFinite(v)));

  // ---- 前向 DP：dp[i][终点槽] = 前 i+1 条的最小总代价（整数单位） ----
  let prevDp: number[] = [];
  const reachableEndSlots: number[][] = [];
  let failAt = -1;
  for (let i = 0; i < n; i += 1) {
    const dp = new Array<number>(endCand[i].length).fill(INF);
    // minPrev[ss] = 上一条可达终点中能与该起点满足间隔的最小前缀代价
    const minPrev: number[] = startCand[i].map(() => (i === 0 ? 0 : INF));
    if (i > 0) {
      for (let ss = 0; ss < startCand[i].length; ss += 1) {
        let m = INF;
        for (let ps = 0; ps < prevDp.length; ps += 1) {
          if (!Number.isFinite(prevDp[ps])) continue;
          if (!gapMsOk(endCandMs[i - 1][ps], startCandMs[i][ss])) continue;
          if (prevDp[ps] < m) m = prevDp[ps];
        }
        minPrev[ss] = m;
      }
    }
    for (let ss = 0; ss < startCand[i].length; ss += 1) {
      if (!Number.isFinite(minPrev[ss])) continue;
      for (let es = 0; es < endCand[i].length; es += 1) {
        const v = pairCost[i][ss][es];
        if (!Number.isFinite(v)) continue;
        const total = minPrev[ss] + v;
        if (total < dp[es]) dp[es] = total;
      }
    }
    if (dp.every((v) => !Number.isFinite(v))) {
      failAt = i;
      break;
    }
    reachableEndSlots.push(dp.map((v, k) => (Number.isFinite(v) ? k : -1)).filter((k) => k >= 0));
    prevDp = dp;
  }

  // ---- 无解：诊断首个无法接续的字幕 ----
  if (failAt >= 0) {
    const i = failAt;
    const cue = sorted[i];
    const base = { ok: false as const, rate, cueId: cue.id, index: i + 1 };
    if (!hasPair(i)) {
      // 自身候选帧内找不到满足「相隔 1 帧 + 最短时长」的起止对
      let maxDurMs = Number.NEGATIVE_INFINITY;
      for (let ss = 0; ss < startCand[i].length; ss += 1) {
        for (let es = 0; es < endCand[i].length; es += 1) {
          if (endCand[i][es] < startCand[i][ss] + 1) continue;
          maxDurMs = Math.max(maxDurMs, endCandMs[i][es] - startCandMs[i][ss]);
        }
      }
      const reason =
        maxDurMs === Number.NEGATIVE_INFINITY
          ? '候选帧（最近帧 ±2）内无法构成相隔至少 1 帧的起止'
          : `候选帧（最近帧 ±2）内可排的最长时长为 ${maxDurMs}ms，小于当前最短时长 ${constraints.minDuration.toFixed(3)}s`;
      return { ...base, kind: 'min-duration', reason };
    }
    // 自身有合法起止对，但接不上上一条：间隔在候选帧内最大仍不足
    let maxGapMs = Number.NEGATIVE_INFINITY;
    for (let ss = 0; ss < startCand[i].length; ss += 1) {
      const usable = pairCost[i][ss].some((v) => Number.isFinite(v));
      if (!usable) continue;
      for (const ps of reachableEndSlots[i - 1] ?? []) {
        maxGapMs = Math.max(maxGapMs, startCandMs[i][ss] - endCandMs[i - 1][ps]);
      }
    }
    return {
      ...base,
      kind: 'min-gap',
      reason: `与上一条（第 ${i} 条）的间隔在候选帧内最大为 ${maxGapMs}ms，小于当前最小间隔 ${constraints.minGap.toFixed(3)}s`
    };
  }

  // 最优总代价（整数单位，精确比较）
  const bestTotal = Math.min(...prevDp.filter(Number.isFinite));

  // ---- 后向 DP：suffix[i][上一条终点槽] = 第 i..n-1 条的最小附加代价 ----
  // suffix[i] 按 endCand[i-1] 的槽位索引；suffixNext(i, es) = i+1<n ? suffix[i+1][es] : 0
  const suffix: number[][] = new Array(n + 1);
  suffix[n] = [];
  for (let i = n - 1; i >= 1; i -= 1) {
    const row = new Array<number>(endCand[i - 1].length).fill(INF);
    for (let ps = 0; ps < endCand[i - 1].length; ps += 1) {
      let best = INF;
      for (let ss = 0; ss < startCand[i].length; ss += 1) {
        if (!gapMsOk(endCandMs[i - 1][ps], startCandMs[i][ss])) continue;
        for (let es = 0; es < endCand[i].length; es += 1) {
          const v = pairCost[i][ss][es];
          if (!Number.isFinite(v)) continue;
          const suf = i + 1 < n ? suffix[i + 1][es] : 0;
          if (v + suf < best) best = v + suf;
        }
      }
      row[ps] = best;
    }
    suffix[i] = row;
  }
  const suffixNext = (i: number, es: number): number =>
    i + 1 < n ? suffix[i + 1][es] : 0;

  // ---- 贪心重建：逐位取仍可达最优解的最小帧号（字典序最小） ----
  const chosen: Array<{ s: number; e: number }> = [];
  let acc = 0;
  let prevEndSlot = -1;
  for (let i = 0; i < n; i += 1) {
    const reachable = (es: number, v: number): boolean =>
      acc + v + suffixNext(i, es) === bestTotal;
    // 起点槽：升序取第一个仍能达成最优解的候选
    let ssPick = -1;
    for (let ss = 0; ss < startCand[i].length; ss += 1) {
      if (i > 0 && !gapMsOk(endCandMs[i - 1][prevEndSlot], startCandMs[i][ss])) continue;
      let ok = false;
      for (let es = 0; es < endCand[i].length; es += 1) {
        const v = pairCost[i][ss][es];
        if (Number.isFinite(v) && reachable(es, v)) {
          ok = true;
          break;
        }
      }
      if (ok) {
        ssPick = ss;
        break;
      }
    }
    // 终点槽：在已定起点下升序取第一个仍能达成最优解的候选
    let esPick = -1;
    let pairV = 0;
    for (let es = 0; es < endCand[i].length; es += 1) {
      const v = pairCost[i][ssPick][es];
      if (Number.isFinite(v) && reachable(es, v)) {
        esPick = es;
        pairV = v;
        break;
      }
    }
    chosen.push({ s: startCand[i][ssPick], e: endCand[i][esPick] });
    acc += pairV;
    prevEndSlot = esPick;
  }

  const plans: FrameGridCuePlan[] = chosen.map((c, i) => ({
    cueId: sorted[i].id,
    index: i + 1,
    startFrame: c.s,
    endFrame: c.e,
    oldStartMs: startMs[i],
    oldEndMs: endMs[i],
    newStartMs: frameTimeMs(rate, c.s),
    newEndMs: frameTimeMs(rate, c.e)
  }));
  const maxUnits = chosen.reduce(
    (m, c, i) =>
      Math.max(m, errorUnits(rate, c.s, startMs[i]), errorUnits(rate, c.e, endMs[i])),
    0
  );

  return {
    ok: true,
    rate,
    plans,
    totalErrorMs: bestTotal / rate.num,
    maxErrorMs: maxUnits / rate.num
  };
}

/** 把帧对齐结果套用到字幕数组（返回新数组，不修改原字幕） */
export function applyFramePlan(cues: Cue[], plans: FrameGridCuePlan[]): Cue[] {
  const byId = new Map(plans.map((p) => [p.cueId, p]));
  return cues.map((c) => {
    const p = byId.get(c.id);
    if (!p) return c;
    return { ...c, start: p.newStartMs / 1000, end: p.newEndMs / 1000 };
  });
}

/** 序列化帧对齐结果：按时间重排并连续编号（毫秒时间码来自帧时间四舍五入） */
export function serializeFrameGrid(cues: Cue[], plans: FrameGridCuePlan[]): string {
  return serializeSrt(applyFramePlan(cues, plans));
}
