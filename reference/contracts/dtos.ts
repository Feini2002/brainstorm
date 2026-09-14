/** Reference contracts. These are not runtime validators or a completed application. */
export type UUID = string;
export type ISODate = string;
export type ItemType = 'idea'|'concept'|'question'|'decision'|'quote'|'todo'|'observation';
export type SourceType = 'chatgpt'|'claude'|'web'|'book'|'myself'|'other';
export type ItemStatus = 'raw'|'processing'|'done'|'error'|'stale';
export type ManualField = 'title'|'summary'|'type'|'tags'|'keywords'|'importance';
export interface SafeError {
  code: string; message: string; retryable: boolean;
  fieldErrors?: Record<string, string[]>;
}
export type ApiResult<T> =
  | {ok:true;data:T;requestId:UUID}
  | {ok:false;error:SafeError;requestId:UUID};
export interface ItemDTO {
  id: UUID; capturedText: string; rawText: string; rawVersion: number; revision: number;
  structuredBaseRawVersion: number|null;
  title: string; summary: string; type: ItemType; tags: string[]; keywords: string[];
  importance: number; manualFields: ManualField[]; status: ItemStatus;
  lastRunId: UUID|null; error: SafeError|null; sourceType: SourceType; sourceRef: string|null;
  createdAt: ISODate; updatedAt: ISODate; isStructuredStale: boolean;
}
export interface TagDTO {id:UUID;label:string;normalized:string;itemCount:number}
export type RelationType = 'similar_to'|'extends'|'supports'|'contradicts'|'causes'|'depends_on'|'example_of'|'related_to';
export type ReviewStatus = 'suggested'|'accepted'|'rejected';
export interface Evidence {itemId:UUID;rawVersion:number;quote:string}
export interface RelationDTO {
  id:UUID;sourceId:UUID;targetId:UUID;type:RelationType;
  origin:'ai'|'manual';reviewStatus:ReviewStatus;score:number|null;reason:string;
  evidence:Evidence[];sourceRawVersion:number;targetRawVersion:number;
  revision:number;runId:UUID|null;createdAt:ISODate;updatedAt:ISODate;isStale:boolean;
}
export interface GraphFilter {
  tagId?:UUID;type?:ItemType;reviewStatuses?:ReviewStatus[];
  minimumScore?:number;includeStale?:boolean;
}
export type SelectionSpec =
  | {mode:'explicit';itemIds:UUID[]}
  | {mode:'filter';filter:GraphFilter};
export interface SourceSnapshot {
  items:{id:UUID;rawVersion:number;revision:number}[];
  relations:{id:UUID;revision:number}[];
}
export interface GraphContent {
  positions:Record<UUID,{x:number;y:number}>;
  direction:'LR'|'TB';viewport?:{x:number;y:number;zoom:number};
}
export interface MindmapContent {
  title:string;
  nodes:{id:string;parentId:string|null;label:string;itemIds:UUID[];kind:'group'|'note'}[];
}
export interface FlowContent {
  title:string;direction:'LR'|'TB';
  nodes:{id:string;label:string;itemIds:UUID[]}[];
  edges:{source:string;target:string;kind:'sequence'|'dependency'|'association'|'causal'|'hypothesis';label:string;itemIds:UUID[];relationIds:UUID[]}[];
}
export interface ViewBase {
  id:UUID;name:string;selection:SelectionSpec;sourceSnapshot:SourceSnapshot;
  contentHash:string|null;rendererVersion:string;promptVersion:string|null;runId:UUID|null;revision:number;
  generatedAt:ISODate|null;createdAt:ISODate;updatedAt:ISODate;
  isStale:boolean;missingSources:UUID[];
}
export type ViewDTO = ViewBase & (
  | {kind:'graph';content:GraphContent}
  | {kind:'mindmap';content:MindmapContent}
  | {kind:'flow';content:FlowContent});
export type RunState = 'running'|'succeeded'|'failed'|'interrupted'|'conflict';
export interface RunDTO {
  id:UUID;kind:'organize'|'mindmap'|'flow'|'connection_test';subjectId:UUID|null;
  state:RunState;startedAt:ISODate;deadlineAt:ISODate;finishedAt:ISODate|null;
  resultRef:UUID|null;error:SafeError|null;attemptCount:number;promptVersion:string;
  usage:{inputTokens:number|null;outputTokens:number|null;totalTokens:number|null}|null;
}
export interface LlmConfig {
  adapter:'openai-compatible';baseUrl:string;model:string;
  structuredMode:'prompt_json'|'json_object';
  tokenField:'none'|'max_tokens'|'max_completion_tokens';maxOutputTokens:number;
  schemaRepairEnabled:boolean;
}
export type KeyChange =
  | {keyAction:'keep';apiKey?:never;confirmKeyTransfer?:boolean}
  | {keyAction:'replace';apiKey:string;confirmKeyTransfer?:never}
  | {keyAction:'delete';apiKey?:never;confirmKeyTransfer?:never};
export type SaveLlmSettings = {expectedRevision:number;config:LlmConfig} & KeyChange;
export interface PublicLlmSettings {revision:number;config:LlmConfig;apiKeyConfigured:boolean}
export interface CaptureRequest {captureRequestId:UUID;rawText:string;sourceType:SourceType;sourceRef:string|null}
export interface OrganizeRequest {requestKey:UUID;expectedRevision:number}
export interface GenerationRequest {
  requestKey:UUID;selection:{mode:'explicit';itemIds:UUID[]};intent?:string;
}
export type FlowGenerationRequest = Omit<GenerationRequest,'intent'> & {intent:string;direction:'LR'|'TB'};
