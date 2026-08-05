import * as v from 'valibot';
import { isBuildIdentity } from '../core/build-info.js';
import { storageUsageSummarySchema } from '../core/image/capture-result.schema.js';
import { MESSAGE_DIRECTION, MessageType, hasVersionedObjectShape } from './message-protocol.js';
import type { MessageType as ProtocolMessageType } from './message-protocol.js';
import type { AlbumRequest, AlbumResponse } from './album-messages.js';
import type {
  BlobKeyRequest,
  BlobKeyResponse,
  BlobKeyResultMessage,
  BlobKeyStatusResultMessage,
  ExportBlobKeyBackupResultMessage,
  ImportBlobKeyBackupResultMessage,
} from './blob-key-messages.js';
import type { DestinationRequest, DestinationResponse } from './destination-messages.js';
import type {
  DeletePanelPositionMessage,
  DeletePanelPositionResultMessage,
  DeleteWorkspaceLayoutMessage,
  DeleteWorkspaceLayoutResultMessage,
  LoadPanelPositionMessage,
  LoadPanelPositionResultMessage,
  LoadWorkspaceLayoutMessage,
  LoadWorkspaceLayoutResultMessage,
  SavePanelPositionMessage,
  SavePanelPositionResultMessage,
  SaveWorkspaceLayoutMessage,
  SaveWorkspaceLayoutResultMessage,
} from './layout-messages.js';
import type { OriginalBlobRequest, OriginalBlobResponse } from './original-blob-messages.js';
import type { RecentHistoryRequest, RecentHistoryResponse } from './recent-history-messages.js';
import { fetchBufferedImageSourceResultPayloadSchema } from './message-schemas.js';
import type { TogglePanelMessage, PingMessage, StatusMessage, UnknownMessageResponse } from './messages/common.js';
import type {
  ToggleBuildIdentityOverlayMessage,
  LoadBuildIdentityMessage,
  LoadBuildIdentityResultMessage,
  LoadParsedFieldStateMessage,
  LoadParsedFieldStateResultMessage,
  LoadParsedFieldStateBySourceMessage,
  LoadParsedFieldStateBySourceResultMessage,
  SaveParsedFieldStateMessage,
  SaveParsedFieldStateResultMessage,
  LoadLocalSettingsMessage,
  LoadLocalSettingsResultMessage,
  SaveLocalSettingsMessage,
  SaveLocalSettingsResultMessage,
} from './messages/panel-messages.js';
import type {
  CaptureImageMessage,
  CaptureResultMessage,
  DownloadImageMessage,
  DownloadImageResultMessage,
  ExportEncryptedImageMessage,
  ExportEncryptedImageResultMessage,
  ImportEncryptedImageMessage,
  ImportEncryptedImageResultMessage,
  StorageUsageRequestMessage,
  StorageUsageResponseMessage,
  DeleteBlobMessage,
  DeleteBlobResultMessage,
  CleanupOrphanedBlobsMessage,
  CleanupOrphanedBlobsResultMessage,
  RetrieveBlobMessage,
  RetrieveBlobResultMessage,
  CreateBlobPreviewMessage,
  CreateDataUrlPreviewMessage,
  CreateBlobPreviewResultMessage,
  GrantPermissionAndCaptureMessage,
} from './messages/blob-messages.js';
import type {
  FetchThumbnailSourceMessage,
  FetchThumbnailSourceResultMessage,
  ProbeImageSourceMessage,
  ProbeImageSourceResultMessage,
  FetchBufferedImageSourceMessage,
  FetchBufferedImageSourceResultMessage,
  CheckImageRequestPolicyMessage,
  CheckImageRequestPolicyResultMessage,
  FetchLinkedPageMessage,
  FetchLinkedPageResultMessage,
} from './messages/image-fetch-messages.js';
import type {
  LoadBookmarksMessage,
  LoadBookmarksResultMessage,
  LoadBookmarksByIdsMessage,
  LoadBookmarksByIdsResultMessage,
  FindBookmarkByUrlMessage,
  FindBookmarkByUrlResultMessage,
  SaveBookmarkMessage,
  SaveBookmarkResultMessage,
  RemoveBookmarkMessage,
  RemoveBookmarkResultMessage,
  RemoveBookmarksMessage,
  RemoveBookmarksResultMessage,
  RemoveRecallBookmarksMessage,
  RemoveRecallBookmarksResultMessage,
} from './messages/bookmark-messages.js';
import type {
  LoadRecallCandidatesMessage,
  LoadRecallCandidatesResultMessage,
  RecallRecordsMessage,
  RecallRecordsResultMessage,
} from './messages/recall-messages.js';
import type {
  PCloudProviderStatusMessage,
  PCloudProviderStatusResultMessage,
  ConnectPCloudProviderMessage,
  ConnectPCloudProviderResultMessage,
  DisconnectPCloudProviderMessage,
  DisconnectPCloudProviderResultMessage,
  UploadPCloudBackupMessage,
  UploadPCloudBackupResultMessage,
  ListPCloudBackupsMessage,
  ListPCloudBackupsResultMessage,
  DownloadPCloudBackupMessage,
  DownloadPCloudBackupResultMessage,
} from './messages/pcloud-messages.js';
import type {
  ListUrlReviewStatusMessage,
  ListUrlReviewStatusResultMessage,
  SaveUrlReviewStatusMessage,
  SaveUrlReviewStatusResultMessage,
  ImportUrlReviewStatusMessage,
  ImportUrlReviewStatusResultMessage,
  ClearUrlReviewStatusMessage,
  ClearUrlReviewStatusResultMessage,
  ListUrlTemplatesMessage,
  ListUrlTemplatesResultMessage,
  SaveUrlTemplateMessage,
  SaveUrlTemplateResultMessage,
  DeleteUrlTemplateMessage,
  DeleteUrlTemplateResultMessage,
  ListGrabSourcePatternsMessage,
  ListGrabSourcePatternsResultMessage,
  SaveGrabSourcePatternMessage,
  SaveGrabSourcePatternResultMessage,
  DeleteGrabSourcePatternMessage,
  DeleteGrabSourcePatternResultMessage,
} from './messages/url-template-messages.js';
export { MESSAGE_DIRECTION, MESSAGE_PROTOCOL_VERSION, MessageType } from './message-protocol.js';
export * from './album-messages.js';
export * from './blob-key-messages.js';
export * from './layout-messages.js';
export * from './original-blob-messages.js';
export * from './recent-history-messages.js';
export * from './messages/common.js';
export * from './messages/panel-messages.js';
export * from './messages/blob-messages.js';
export * from './messages/image-fetch-messages.js';
export * from './messages/bookmark-messages.js';
export * from './messages/recall-messages.js';
export * from './messages/pcloud-messages.js';
export * from './messages/url-template-messages.js';

const deleteBlobResultPayloadSchema = v.object({
  deleted: v.boolean(),
  usage: storageUsageSummarySchema,
});

export type ExtensionRequest =
  | TogglePanelMessage
  | ToggleBuildIdentityOverlayMessage
  | PingMessage
  | LoadBuildIdentityMessage
  | DestinationRequest
  | AlbumRequest
  | CaptureImageMessage
  | DownloadImageMessage
  | ExportEncryptedImageMessage
  | ImportEncryptedImageMessage
  | StorageUsageRequestMessage
  | DeleteBlobMessage
  | CleanupOrphanedBlobsMessage
  | RetrieveBlobMessage
  | OriginalBlobRequest
  | CreateBlobPreviewMessage
  | CreateDataUrlPreviewMessage
  | FetchThumbnailSourceMessage
  | ProbeImageSourceMessage
  | FetchBufferedImageSourceMessage
  | CheckImageRequestPolicyMessage
  | FetchLinkedPageMessage
  | GrantPermissionAndCaptureMessage
  | BlobKeyRequest
  | LoadBookmarksMessage
  | LoadBookmarksByIdsMessage
  | FindBookmarkByUrlMessage
  | SaveBookmarkMessage
  | RemoveBookmarkMessage
  | RemoveBookmarksMessage
  | RemoveRecallBookmarksMessage
  | RecentHistoryRequest
  | LoadRecallCandidatesMessage
  | RecallRecordsMessage
  | LoadPanelPositionMessage
  | SavePanelPositionMessage
  | DeletePanelPositionMessage
  | LoadWorkspaceLayoutMessage
  | SaveWorkspaceLayoutMessage
  | DeleteWorkspaceLayoutMessage
  | LoadParsedFieldStateMessage
  | LoadParsedFieldStateBySourceMessage
  | SaveParsedFieldStateMessage
  | ListUrlReviewStatusMessage
  | SaveUrlReviewStatusMessage
  | ImportUrlReviewStatusMessage
  | ClearUrlReviewStatusMessage
  | LoadLocalSettingsMessage
  | SaveLocalSettingsMessage
  | PCloudProviderStatusMessage
  | ConnectPCloudProviderMessage
  | DisconnectPCloudProviderMessage
  | UploadPCloudBackupMessage
  | ListPCloudBackupsMessage
  | DownloadPCloudBackupMessage
  | import('./interop-runtime-messages.js').InteropRuntimeMessage
  | ListUrlTemplatesMessage
  | SaveUrlTemplateMessage
  | DeleteUrlTemplateMessage
  | ListGrabSourcePatternsMessage
  | SaveGrabSourcePatternMessage
  | DeleteGrabSourcePatternMessage;

export type ExtensionResponse =
  | StatusMessage
  | UnknownMessageResponse
  | LoadBuildIdentityResultMessage
  | DestinationResponse
  | AlbumResponse
  | CaptureResultMessage
  | DownloadImageResultMessage
  | ExportEncryptedImageResultMessage
  | ImportEncryptedImageResultMessage
  | StorageUsageResponseMessage
  | DeleteBlobResultMessage
  | CleanupOrphanedBlobsResultMessage
  | RetrieveBlobResultMessage
  | OriginalBlobResponse
  | CreateBlobPreviewResultMessage
  | FetchThumbnailSourceResultMessage
  | ProbeImageSourceResultMessage
  | FetchBufferedImageSourceResultMessage
  | CheckImageRequestPolicyResultMessage
  | FetchLinkedPageResultMessage
  | BlobKeyResponse
  | LoadBookmarksResultMessage
  | LoadBookmarksByIdsResultMessage
  | FindBookmarkByUrlResultMessage
  | SaveBookmarkResultMessage
  | RemoveBookmarkResultMessage
  | RemoveBookmarksResultMessage
  | RemoveRecallBookmarksResultMessage
  | RecentHistoryResponse
  | LoadRecallCandidatesResultMessage
  | RecallRecordsResultMessage
  | LoadPanelPositionResultMessage
  | SavePanelPositionResultMessage
  | DeletePanelPositionResultMessage
  | LoadWorkspaceLayoutResultMessage
  | SaveWorkspaceLayoutResultMessage
  | DeleteWorkspaceLayoutResultMessage
  | LoadParsedFieldStateResultMessage
  | LoadParsedFieldStateBySourceResultMessage
  | SaveParsedFieldStateResultMessage
  | ListUrlReviewStatusResultMessage
  | SaveUrlReviewStatusResultMessage
  | ImportUrlReviewStatusResultMessage
  | ClearUrlReviewStatusResultMessage
  | LoadLocalSettingsResultMessage
  | SaveLocalSettingsResultMessage
  | PCloudProviderStatusResultMessage
  | ConnectPCloudProviderResultMessage
  | DisconnectPCloudProviderResultMessage
  | UploadPCloudBackupResultMessage
  | ListPCloudBackupsResultMessage
  | DownloadPCloudBackupResultMessage
  | import('./interop-runtime-messages.js').InteropRuntimeResultMessage
  | ListUrlTemplatesResultMessage
  | SaveUrlTemplateResultMessage
  | DeleteUrlTemplateResultMessage
  | ListGrabSourcePatternsResultMessage
  | SaveGrabSourcePatternResultMessage
  | DeleteGrabSourcePatternResultMessage;

export function isExtensionRequest(value: unknown): value is ExtensionRequest {
  if (!hasVersionedObjectShape(value)) return false;
  return MESSAGE_DIRECTION[value.type as ProtocolMessageType] === 'request';
}

export function isExtensionResponse(value: unknown): value is ExtensionResponse {
  if (!hasVersionedObjectShape(value)) return false;
  return MESSAGE_DIRECTION[value.type as ProtocolMessageType] === 'response';
}

export function isBlobKeyResultMessage(value: unknown): value is BlobKeyResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.BlobKeyResult;
}

export function isExportBlobKeyBackupResultMessage(value: unknown): value is ExportBlobKeyBackupResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ExportBlobKeyBackupResult;
}

export function isImportBlobKeyBackupResultMessage(value: unknown): value is ImportBlobKeyBackupResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ImportBlobKeyBackupResult;
}

export function isBlobKeyStatusResultMessage(value: unknown): value is BlobKeyStatusResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.BlobKeyStatusResult;
}

export function isRetrieveBlobResultMessage(value: unknown): value is RetrieveBlobResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.RetrieveBlobResult;
}

export function isCleanupOrphanedBlobsResultMessage(value: unknown): value is CleanupOrphanedBlobsResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.CleanupOrphanedBlobsResult;
}

export function isDeleteBlobResultMessage(value: unknown): value is DeleteBlobResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  if (value.type !== MessageType.DeleteBlobResult) return false;
  return v.is(deleteBlobResultPayloadSchema, value.payload);
}

export function isStorageUsageResponseMessage(value: unknown): value is StorageUsageResponseMessage {
  if (!hasVersionedObjectShape(value)) return false;
  if (value.type !== MessageType.StorageUsageResponse) return false;
  return v.is(storageUsageSummarySchema, value.payload);
}

export function isCreateBlobPreviewResultMessage(value: unknown): value is CreateBlobPreviewResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.CreateBlobPreviewResult;
}

export function isFetchThumbnailSourceResultMessage(value: unknown): value is FetchThumbnailSourceResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.FetchThumbnailSourceResult;
}

export function isProbeImageSourceResultMessage(value: unknown): value is ProbeImageSourceResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ProbeImageSourceResult;
}

export function isFetchBufferedImageSourceResultMessage(value: unknown): value is FetchBufferedImageSourceResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.FetchBufferedImageSourceResult && v.is(fetchBufferedImageSourceResultPayloadSchema, value.payload);
}

export function isCheckImageRequestPolicyResultMessage(value: unknown): value is CheckImageRequestPolicyResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.CheckImageRequestPolicyResult;
}

export function isFetchLinkedPageResultMessage(value: unknown): value is FetchLinkedPageResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.FetchLinkedPageResult;
}

export function isCaptureResultMessage(value: unknown): value is CaptureResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.CaptureResult;
}

export function isDownloadImageResultMessage(value: unknown): value is DownloadImageResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.DownloadImageResult;
}

export function isExportEncryptedImageResultMessage(value: unknown): value is ExportEncryptedImageResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ExportEncryptedImageResult;
}

export function isImportEncryptedImageResultMessage(value: unknown): value is ImportEncryptedImageResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ImportEncryptedImageResult;
}

export function isLoadBookmarksResultMessage(value: unknown): value is LoadBookmarksResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.LoadBookmarksResult;
}

export function isLoadBookmarksByIdsResultMessage(value: unknown): value is LoadBookmarksByIdsResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.LoadBookmarksByIdsResult;
}

export function isFindBookmarkByUrlResultMessage(value: unknown): value is FindBookmarkByUrlResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.FindBookmarkByUrlResult;
}

export function isSaveBookmarkResultMessage(value: unknown): value is SaveBookmarkResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.SaveBookmarkResult;
}

export function isRemoveBookmarkResultMessage(value: unknown): value is RemoveBookmarkResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.RemoveBookmarkResult;
}

export function isRemoveBookmarksResultMessage(value: unknown): value is RemoveBookmarksResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.RemoveBookmarksResult;
}

export function isRemoveRecallBookmarksResultMessage(value: unknown): value is RemoveRecallBookmarksResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.RemoveRecallBookmarksResult;
}

export function isLoadRecallCandidatesResultMessage(value: unknown): value is LoadRecallCandidatesResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.LoadRecallCandidatesResult;
}

export function isRecallRecordsResultMessage(value: unknown): value is RecallRecordsResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.RecallRecordsResult;
}

export function isLoadParsedFieldStateResultMessage(value: unknown): value is LoadParsedFieldStateResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.LoadParsedFieldStateResult;
}

export function isLoadParsedFieldStateBySourceResultMessage(value: unknown): value is LoadParsedFieldStateBySourceResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.LoadParsedFieldStateBySourceResult;
}

export function isSaveParsedFieldStateResultMessage(value: unknown): value is SaveParsedFieldStateResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.SaveParsedFieldStateResult;
}

export function isListUrlReviewStatusResultMessage(value: unknown): value is ListUrlReviewStatusResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ListUrlReviewStatusResult;
}

export function isSaveUrlReviewStatusResultMessage(value: unknown): value is SaveUrlReviewStatusResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.SaveUrlReviewStatusResult;
}

export function isImportUrlReviewStatusResultMessage(value: unknown): value is ImportUrlReviewStatusResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ImportUrlReviewStatusResult;
}

export function isClearUrlReviewStatusResultMessage(value: unknown): value is ClearUrlReviewStatusResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ClearUrlReviewStatusResult;
}

export function isLoadLocalSettingsResultMessage(value: unknown): value is LoadLocalSettingsResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.LoadLocalSettingsResult;
}

export function isSaveLocalSettingsResultMessage(value: unknown): value is SaveLocalSettingsResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.SaveLocalSettingsResult;
}

export function isPCloudProviderStatusResultMessage(value: unknown): value is PCloudProviderStatusResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.PCloudProviderStatusResult;
}

export function isConnectPCloudProviderResultMessage(value: unknown): value is ConnectPCloudProviderResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ConnectPCloudProviderResult;
}

export function isDisconnectPCloudProviderResultMessage(value: unknown): value is DisconnectPCloudProviderResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.DisconnectPCloudProviderResult;
}

export function isUploadPCloudBackupResultMessage(value: unknown): value is UploadPCloudBackupResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.UploadPCloudBackupResult;
}

export function isListPCloudBackupsResultMessage(value: unknown): value is ListPCloudBackupsResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ListPCloudBackupsResult;
}

export function isDownloadPCloudBackupResultMessage(value: unknown): value is DownloadPCloudBackupResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.DownloadPCloudBackupResult;
}

export function isListUrlTemplatesResultMessage(value: unknown): value is ListUrlTemplatesResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ListUrlTemplatesResult;
}

export function isSaveUrlTemplateResultMessage(value: unknown): value is SaveUrlTemplateResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.SaveUrlTemplateResult;
}

export function isDeleteUrlTemplateResultMessage(value: unknown): value is DeleteUrlTemplateResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.DeleteUrlTemplateResult;
}

export function isListGrabSourcePatternsResultMessage(value: unknown): value is ListGrabSourcePatternsResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.ListGrabSourcePatternsResult;
}

export function isSaveGrabSourcePatternResultMessage(value: unknown): value is SaveGrabSourcePatternResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.SaveGrabSourcePatternResult;
}

export function isDeleteGrabSourcePatternResultMessage(value: unknown): value is DeleteGrabSourcePatternResultMessage {
  if (!hasVersionedObjectShape(value)) return false;
  return value.type === MessageType.DeleteGrabSourcePatternResult;
}

export function isStatusMessage(value: unknown): value is StatusMessage {
  if (!isExtensionResponse(value) || value.type !== MessageType.Status) return false;
  const payload = value.payload as { panelVisible?: unknown; status?: unknown };
  return typeof payload.panelVisible === 'boolean' && typeof payload.status === 'string';
}

export function isLoadBuildIdentityResultMessage(value: unknown): value is LoadBuildIdentityResultMessage {
  if (!isExtensionResponse(value) || value.type !== MessageType.LoadBuildIdentityResult) return false;
  const payload = value.payload as { ok?: unknown; identity?: unknown; message?: unknown };
  if (payload.ok === true) return isBuildIdentity(payload.identity);
  if (payload.ok === false) return payload.identity === null && typeof payload.message === 'string';
  return false;
}
