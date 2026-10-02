/**
 * Record-to-wire mapping.
 *
 * These sit in a leaf module because both the work layer and the approval
 * layer need to describe the same work item, and a shared leaf keeps them from
 * importing each other.
 */

import type { WorkDTO } from "../shared/contracts.ts";
import type { WorkRecord } from "./documents.ts";

export function toWorkDTO(record: WorkRecord, employeeName: string, roomName: string): WorkDTO {
  const dto: WorkDTO = {
    id: record.id,
    employeeId: record.employeeId,
    employeeName,
    roomId: record.roomId,
    roomName,
    kind: record.kind,
    status: record.status,
    rootWorkId: record.rootWorkId,
    depth: record.depth,
    startedAt: record.startedAt,
  };
  if (record.sourceEntryId.length > 0) dto.sourceEntryId = record.sourceEntryId;
  if (record.parentWorkId.length > 0) dto.parentWorkId = record.parentWorkId;
  if (record.finishedAt > 0) dto.finishedAt = record.finishedAt;
  if (record.error.length > 0) dto.error = record.error;
  if (record.answer.length > 0) dto.answer = record.answer;
  dto.usage = { input: record.inputTokens, output: record.outputTokens, cost: record.cost };
  return dto;
}
