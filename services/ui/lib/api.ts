// Barrel re-export — all consumers import from this file unchanged.
// Domain modules live under lib/api/*.

export type { ExtractSource, ExtractRule, FlowStep, ParsedTestIntent, ChatAttachment, FlowTestConfig } from '@alt/shared';

export { RECORDER_URL } from './api/core';

export type {
  TestRequest, TestResult, ActiveTest, LiveMetricPoint, TrendPoint, ThresholdPreview,
  BackendMetrics, ClientMetrics,
} from './api/tests';
export {
  createTest, getResults, getResult, getActiveTests, getLiveMetrics,
  getExecutionLog, cancelTest, setBaseline, clearBaseline, compareResults, getTrend,
  previewThresholds,
} from './api/tests';

export type { SavedScript, SavedScriptVersion, ScriptEditResponse } from '@alt/shared';
export { getScripts, getScript, getScriptVersions, saveScript, restoreScriptVersion, editScriptChat } from './api/scripts';

export type { Webhook } from './api/webhooks';
export { getWebhooks, createWebhook, deleteWebhook } from './api/webhooks';

export type { Schedule } from './api/schedules';
export { getSchedules, createSchedule, updateSchedule, deleteSchedule, runSchedule } from './api/schedules';

export type { Preset } from './api/presets';
export { getPresets, createPreset, getPreset, deletePreset } from './api/presets';

export type { WorkerMetrics, ServiceHealth, SystemHealth, AIStatus, LiveMetricWindowSec, OperationalSettings } from './api/system';
export { getSystemHealth, getAIStatus, getLiveMetricWindow, setLiveMetricWindow, getOperationalSettings, setOperationalSettings } from './api/system';

export type { LogSource } from './api/logSources';
export { interpolateLogSourceUrl, getLogSources, createLogSource, updateLogSource, deleteLogSource } from './api/logSources';

export type { RecordingSession } from './api/recording';
export { startRecording, stopRecording, getRecording } from './api/recording';

export type { Workspace } from './api/workspaces';
export { getWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace } from './api/workspaces';

export type {
  ThresholdSuggestion, ErrorDiagnosis, SettingsSuggestion, ChatMessage, ChatParseResponse,
} from './api/ai';
export {
  diagnoseErrors, parseChatPrompt, predictWebhookNoise, suggestPresetName, suggestParamColumns,
  translatePlaywright, convertCron, suggestSettings, getTrendNarrative, suggestThresholds,
} from './api/ai';

export type { SessionUser } from './api/auth';
export { register, login, logout, getMe, switchTeam } from './api/auth';

export type {
  TeamRole, TeamMemberRow, TeamQuota, TeamUsage, AiProviderName, AiProviderConfig,
  AuditLogEntry, EraseTeamDataResult,
} from './api/teams';
export {
  getTeamMembers, addTeamMember, updateTeamMemberRole, removeTeamMember,
  getTeamQuota, updateTeamQuota,
  getAiProvider, setAiProvider, setTeamAiProvider, clearTeamAiProvider,
  getAuditLog, eraseTeamData,
} from './api/teams';

export type { OrgRole, OrgMemberRow, OrgTeamSummary, OrgDetail } from './api/orgs';
export { createOrg, getOrg, addOrgMember, updateOrgMemberRole, removeOrgMember, createOrgTeam } from './api/orgs';

export type { TeamApiKeyRow, TeamApiKeyCreated } from './api/apiKeys';
export { getTeamApiKeys, createTeamApiKey, revokeTeamApiKey } from './api/apiKeys';
