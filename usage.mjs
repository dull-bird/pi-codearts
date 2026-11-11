import { signedFetch } from './core.mjs';

export const USAGE_PATH = '/snap-manager/v1/statistics/plugin';
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const percentage = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined;

// The official client's subscription endpoint exposes aggregate quotas as
// percentages in model_metrics, unlike the absolute values in metrics.
// Preserve both representations without pretending they have the same units.
export function summarizeUsage(data) {
  const metrics = (Array.isArray(data?.metrics) ? data.metrics : []).map(metric => ({
    name: metric.name, visible: metric.show !== false,
    used: amount(metric.usage_token_num), total: amount(metric.package_token_amount),
    usedPercent: percentage(metric.value >= 0 ? metric.value : undefined),
  }));
  const models = (Array.isArray(data?.model_metrics) ? data.model_metrics : []).map(metric => ({
    name: metric.model_sku || metric.name, visible: metric.show !== false,
    enabled: metric.enable, status: metric.status,
    used: amount(metric.usage_token_num), total: amount(metric.package_token_amount),
    usedPercent: percentage(metric.usage_token),
  }));
  const token = metrics.find(metric => metric.name === 'usageTokenChatMessages' && metric.visible);
  return {
    packageName: data?.package?.package_name_cn || data?.package?.package_name_en || data?.package?.spec_code || 'CodeArts',
    packageCode: data?.package?.spec_code,
    status: data?.package?.status,
    isTokenPackage: data?.package?.is_token_package,
    isCreditPackage: data?.package?.is_credit_package,
    startDate: data?.start_date, endDate: data?.end_date,
    metrics, models,
    token: token && token.total !== undefined ? {
      used: token.used, total: token.total,
      remaining: token.used === undefined ? undefined : Math.max(0, token.total - token.used),
    } : undefined,
  };
}
const count = value => value === undefined ? '未返回' : Math.round(value).toLocaleString('en-US');
export function formatUsage(summary, portalUrl = 'https://codearts.huaweicloud.com/portal/settings/personal-usage?locale=zh-cn') {
  const lines = [`套餐: ${summary.packageName}（${summary.status || '状态未返回'}）`];
  if (summary.startDate || summary.endDate) lines.push(`统计周期: ${summary.startDate || '?'} 至 ${summary.endDate || '?'}`);
  if (summary.token) lines.push(`对话 Token: 已用 ${count(summary.token.used)} / 总额 ${count(summary.token.total)}\n剩余 ${count(summary.token.remaining)}（按接口数值计算）`);
  else if (summary.metrics.length) lines.push(...summary.metrics.filter(metric => metric.visible).map(metric => `${metric.name}: 已用 ${count(metric.used)}${metric.total === undefined ? '' : ` / 总额 ${count(metric.total)}`}${metric.usedPercent === undefined ? '' : `；接口用量 ${metric.usedPercent}%`}`));
  else lines.push('接口未返回个人 Token 总额度');
  if (summary.models.length) {
    lines.push('模型额度:');
    for (const model of summary.models) lines.push(`- ${model.name || '未命名'}: ${model.usedPercent === undefined ? '未返回百分比' : `已用 ${model.usedPercent}%`}${model.total === undefined ? '' : `；已用 ${count(model.used)} / ${count(model.total)}`}${model.enabled === false ? '；未启用' : ''}${model.status ? `；${model.status}` : ''}`);
  }
  if (summary.isCreditPackage) lines.push('这是积分套餐；积分余额与上述 Token 字段不是同一计量单位。');
  if (summary.token && !summary.isTokenPackage) lines.push('接口同时返回了 Token 数值；以控制台套餐说明为准，不能据此换算现金余额。');
  lines.push(`详情: ${portalUrl}`);
  return lines.join('\n');
}
export async function queryUsage(auth, signal, environment, fetchImpl = fetch) {
  // This endpoint is the official CodeArts client's subscription API. Other
  // environments require an explicit verified path; never probe arbitrary hosts.
  if (!environment?.paths?.usage) throw new Error(`CodeArts 用量查询仅适配官方环境；${environment?.label || '此环境'}未配置已验证的用量接口`);
  if (environment.apiOrigin !== 'https://snap-access.cn-north-4.myhuaweicloud.com' || environment.paths.usage !== USAGE_PATH) throw new Error('CodeArts usage endpoint is not trusted');
  const response = await signedFetch(environment.apiOrigin + environment.paths.usage, auth, { signal, fetchImpl, environment });
  let data;
  try { data = await response.json(); }
  catch { throw new Error(`CodeArts 用量查询: HTTP ${response.status}，非 JSON 响应`); }
  if (!response.ok || data?.error_code || data?.code !== undefined && data.code !== 0) throw new Error(`CodeArts 用量查询失败: ${data?.error_code || data?.code || `HTTP ${response.status}`}`);
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.package !== undefined && (typeof data.package !== 'object' || Array.isArray(data.package))) throw new Error('CodeArts 用量查询: 响应格式不兼容');
  return summarizeUsage(data);
}
