/**
 * Client state.
 *
 * One reducer holds the bootstrap snapshot; server events fold into it. Events
 * that name a full record (a room, a work item, an approval) update in place,
 * and the coarse events ("employees", "skills", …) refetch their surface, which
 * keeps the reducer free of domain rules.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";
import { createElement } from "react";
import type {
  ApprovalDTO,
  AppConfigDTO,
  CustomProviderConfigDTO,
  EmployeeDTO,
  MessageDTO,
  ModelInfoDTO,
  ProviderStatusDTO,
  RoomDTO,
  ServerEvent,
  SkillDTO,
  WorkContextDTO,
  WorkDTO,
} from "../shared/contracts.ts";
import type { BootstrapDTO } from "../shared/contracts.ts";
import { errorDisplay, type DisplayText } from "../shared/i18n.ts";
import { api, subscribeEvents } from "./api.ts";
import { uiText } from "./messages.ts";

export type View = "chat" | "mail" | "approvals" | "employees" | "work" | "work-contexts" | "settings";

export type State = {
  ready: boolean;
  connected: boolean;
  error: DisplayText | undefined;
  app: AppConfigDTO | undefined;
  employees: EmployeeDTO[];
  rooms: RoomDTO[];
  workContexts: WorkContextDTO[];
  work: WorkDTO[];
  approvals: ApprovalDTO[];
  skills: SkillDTO[];
  models: ModelInfoDTO[];
  providers: ProviderStatusDTO[];
  customProviders: CustomProviderConfigDTO[];
  mcpServers: BootstrapDTO["mcpServers"];
  activeRoomId: string | undefined;
  activeWorkContextId: string | undefined;
  messages: MessageDTO[];
  view: View;
  notice: { id: number; text: DisplayText } | undefined;
  /**
   * Bumped whenever a mail could have changed on the server: the mailbox is a
   * server-owned view, so it is refetched on this revision rather than patched.
   */
  mailRevision: number;
  storagePath: string;
};

const initialState: State = {
  ready: false,
  connected: false,
  error: undefined,
  app: undefined,
  employees: [],
  rooms: [],
  workContexts: [],
  work: [],
  approvals: [],
  skills: [],
  models: [],
  providers: [],
  customProviders: [],
  mcpServers: [],
  activeRoomId: undefined,
  activeWorkContextId: undefined,
  messages: [],
  view: "chat",
  notice: undefined,
  mailRevision: 0,
  storagePath: "",
};

type Action =
  | { type: "bootstrap"; payload: BootstrapDTO; models: ModelInfoDTO[] }
  | { type: "connected"; value: boolean }
  | { type: "error"; message: DisplayText | undefined }
  | { type: "view"; view: View }
  | { type: "app"; app: AppConfigDTO }
  | { type: "employees"; employees: EmployeeDTO[] }
  | { type: "rooms"; rooms: RoomDTO[] }
  | { type: "room"; room: RoomDTO }
  | { type: "workContexts"; workContexts: WorkContextDTO[] }
  | { type: "workContext"; workContext: WorkContextDTO }
  | { type: "activeWorkContext"; workContextId: string | undefined }
  | { type: "work"; work: WorkDTO[] }
  | { type: "workOne"; work: WorkDTO }
  | { type: "workProgress"; workId: string; progressText: string; tools: WorkDTO["tools"] }
  | { type: "approvals"; approvals: ApprovalDTO[] }
  | { type: "approval"; approval: ApprovalDTO }
  | { type: "skills"; skills: SkillDTO[] }
  | { type: "mcp"; servers: BootstrapDTO["mcpServers"] }
  | {
      type: "models";
      models: ModelInfoDTO[];
      providers: ProviderStatusDTO[];
      customProviders: CustomProviderConfigDTO[];
    }
  | { type: "activeRoom"; roomId: string | undefined }
  | { type: "messages"; messages: MessageDTO[] }
  | { type: "message"; roomId: string; message: MessageDTO }
  | { type: "notice"; text: DisplayText }
  | { type: "mailChanged" };

function upsert<T extends { id: string }>(list: readonly T[], item: T): T[] {
  const index = list.findIndex((entry) => entry.id === item.id);
  if (index < 0) return [item, ...list];
  const copy = [...list];
  copy[index] = item;
  return copy;
}

function bootstrapWorkContextId(
  state: State,
  workContexts: readonly WorkContextDTO[],
  rooms: readonly RoomDTO[],
  activeRoomId: string | undefined,
): string | undefined {
  const currentRoom = rooms.find((room) => room.id === activeRoomId);
  if (currentRoom !== undefined && workContexts.some((workContext) => workContext.id === currentRoom.workContextId)) {
    return currentRoom.workContextId;
  }
  if (state.activeWorkContextId !== undefined && workContexts.some((workContext) => workContext.id === state.activeWorkContextId)) {
    return state.activeWorkContextId;
  }
  return workContexts[0]?.id;
}

function retainedWorkContextId(state: State, workContexts: readonly WorkContextDTO[]): string | undefined {
  if (state.activeWorkContextId !== undefined && workContexts.some((workContext) => workContext.id === state.activeWorkContextId)) {
    return state.activeWorkContextId;
  }
  const currentRoom = state.rooms.find((room) => room.id === state.activeRoomId);
  if (currentRoom !== undefined && workContexts.some((workContext) => workContext.id === currentRoom.workContextId)) {
    return currentRoom.workContextId;
  }
  return workContexts[0]?.id;
}



function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "bootstrap": {
      const workContexts = [...action.payload.workContexts].sort((left, right) => right.updatedAt - left.updatedAt);
      const activeRoomId = state.activeRoomId ?? action.payload.rooms[0]?.id;
      return {
        ...state,
        ready: true,
        app: action.payload.app,
        employees: action.payload.employees,
        rooms: action.payload.rooms,
        workContexts,
        activeWorkContextId: bootstrapWorkContextId(state, workContexts, action.payload.rooms, activeRoomId),
        work: action.payload.work,
        approvals: action.payload.approvals,
        skills: action.payload.skills,
        mcpServers: action.payload.mcpServers,
        providers: action.payload.providers,
        customProviders: action.payload.customProviders,
        storagePath: action.payload.storagePath,
        models: action.models,
        activeRoomId,
      };
    }
    case "workContexts": {
      const workContexts = [...action.workContexts].sort((left, right) => right.updatedAt - left.updatedAt);
      return {
        ...state,
        workContexts,
        activeWorkContextId: retainedWorkContextId(state, workContexts),
      };
    }
    case "workContext": {
      const workContexts = [...upsert(state.workContexts, action.workContext)].sort(
        (left, right) => right.updatedAt - left.updatedAt,
      );
      return {
        ...state,
        workContexts,
        activeWorkContextId: retainedWorkContextId(state, workContexts),
      };
    }
    case "activeWorkContext":
      return { ...state, activeWorkContextId: action.workContextId };
    case "connected":
      return { ...state, connected: action.value };
    case "error":
      return { ...state, error: action.message };
    case "view":
      return { ...state, view: action.view };
    case "app":
      return { ...state, app: action.app };
    case "employees":
      return { ...state, employees: action.employees };
    case "rooms":
      return {
        ...state,
        rooms: action.rooms,
        activeRoomId: state.activeRoomId ?? action.rooms[0]?.id,
      };
    case "room": {
      const exists = state.rooms.some((room) => room.id === action.room.id);
      return { ...state, rooms: exists ? upsert(state.rooms, action.room) : [action.room, ...state.rooms] };
    }
    case "work":
      return { ...state, work: action.work };
    case "workOne":
      return { ...state, work: upsert(state.work, action.work) };
    case "workProgress": {
      const index = state.work.findIndex((item) => item.id === action.workId);
      if (index < 0) return state;
      const copy = [...state.work];
      const current = copy[index]!;
      copy[index] = {
        ...current,
        progressText: action.progressText,
        ...(action.tools !== undefined ? { tools: action.tools } : {}),
      };
      return { ...state, work: copy };
    }
    case "approvals":
      return { ...state, approvals: action.approvals };
    case "approval":
      return { ...state, approvals: upsert(state.approvals, action.approval) };
    case "skills":
      return { ...state, skills: action.skills };
    case "mcp":
      return { ...state, mcpServers: action.servers };
    case "models":
      return {
        ...state,
        models: action.models,
        providers: action.providers,
        customProviders: action.customProviders,
      };
    case "activeRoom": {
      const room = state.rooms.find((entry) => entry.id === action.roomId);
      return {
        ...state,
        activeRoomId: action.roomId,
        activeWorkContextId: room?.workContextId ?? state.activeWorkContextId,
        messages: action.roomId === state.activeRoomId ? state.messages : [],
      };
    }
    case "messages":
      return { ...state, messages: action.messages };
    case "message":
      if (action.roomId !== state.activeRoomId) return state;
      if (state.messages.some((message) => message.id === action.message.id)) return state;
      return { ...state, messages: [...state.messages, action.message] };
    case "notice":
      return { ...state, notice: { id: Date.now(), text: action.text } };
    case "mailChanged":
      return { ...state, mailRevision: state.mailRevision + 1 };
    default:
      return state;
  }
}

type ContextValue = {
  state: State;
  dispatch: (action: Action) => void;
  refreshRooms: () => Promise<void>;
  refreshEmployees: () => Promise<void>;
  refreshWork: () => Promise<void>;
  refreshApprovals: () => Promise<void>;
  refreshModels: () => Promise<void>;
  openRoom: (roomId: string) => Promise<void>;
  reload: () => Promise<void>;
  setError: (message: DisplayText | undefined) => void;
};

const AppContext = createContext<ContextValue | undefined>(undefined);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  // The SSE handler runs outside the render it was created in, so the address
  // it needs to recognise the user's own mail lives in a ref.
  const userAddress = useRef("");

  const refreshRooms = useCallback(async () => {
    dispatch({ type: "rooms", rooms: await api.rooms() });
  }, []);

  const refreshEmployees = useCallback(async () => {
    const bootstrap = await api.bootstrap();
    dispatch({ type: "employees", employees: bootstrap.employees });
  }, []);

  const refreshWork = useCallback(async () => {
    dispatch({ type: "work", work: await api.works() });
  }, []);

  const refreshApprovals = useCallback(async () => {
    const payload = await api.approvals();
    dispatch({ type: "approvals", approvals: payload.approvals });
  }, []);

  /**
   * Refresh only the model surfaces.
   *
   * `reload` reopens the first room, which would yank the user out of the page
   * they are configuring; auth and custom-provider changes must not do that.
   */
  const refreshModels = useCallback(async () => {
    const [catalog, custom] = await Promise.all([api.models(), api.customProviders()]);
    dispatch({
      type: "models",
      models: catalog.models,
      providers: catalog.providers,
      customProviders: custom.providers,
    });
  }, []);

  const openRoom = useCallback(async (roomId: string) => {
    dispatch({ type: "activeRoom", roomId });
    const payload = await api.messages(roomId);
    dispatch({ type: "messages", messages: payload.messages });
  }, []);

  const reload = useCallback(async () => {
    try {
      const [bootstrap, models] = await Promise.all([api.bootstrap(), api.models()]);
      userAddress.current = bootstrap.app.user.address;
      dispatch({ type: "bootstrap", payload: bootstrap, models: models.models });
      // The bootstrap snapshot carries the room list, not a transcript, so the
      // pane has to open a room or the app starts on an empty conversation.
      const room = bootstrap.rooms.find((entry) => entry.kind !== "mail") ?? bootstrap.rooms[0];
      if (room === undefined) return;
      if (room.kind === "mail") dispatch({ type: "view", view: "mail" });
      await openRoom(room.id);
    } catch (error) {
      dispatch({ type: "error", message: errorDisplay(error) });
    }
  }, [openRoom]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    const handle = (event: ServerEvent) => {
      switch (event.type) {
        case "message": {
          dispatch({ type: "message", roomId: event.roomId, message: event.message });
          void refreshRooms();
          // A complete mail from an employee is news the user must be able to
          // notice from any page; the mailbox refreshes and the notice names
          // it. Employee-to-employee mail is not the user's news.
          if (
            event.message.mail !== undefined &&
            event.message.author.type === "employee" &&
            event.message.mail.draft !== true &&
            userAddress.current.length > 0 &&
            [...event.message.mail.to, ...event.message.mail.cc].some(
              (entry) => entry.address === userAddress.current,
            )
          ) {
            dispatch({ type: "mailChanged" });
            const subject = event.message.mail.subject;
            dispatch({
              type: "notice",
              text: uiText((messages) => messages.app.newMail(subject.length > 0 ? subject : messages.app.emptySubject)),
            });
          }
          break;
        }
        case "room":
          dispatch({ type: "room", room: event.room });
          dispatch({ type: "mailChanged" });
          break;
        case "work-context":
          dispatch({ type: "workContext", workContext: event.workContext });
          break;
        case "work":
          dispatch({ type: "workOne", work: event.work });
          break;
        case "work-progress":
          dispatch({
            type: "workProgress",
            workId: event.workId,
            progressText: event.progressText,
            tools: event.tools,
          });
          break;
        case "approval":
          dispatch({ type: "approval", approval: event.approval });
          void refreshWork();
          break;
        case "approvals":
          // Approval changes move a work item between "running" and
          // "waiting-approval", so both surfaces are refreshed together.
          void refreshApprovals();
          void refreshWork();
          break;
        case "employee":
          void refreshEmployees();
          break;
        case "employees":
          void refreshEmployees();
          break;
        case "skills":
          void api.skills().then((payload) => dispatch({ type: "skills", skills: payload.skills }));
          break;
        case "mcp":
          void api.mcpServers().then((payload) => dispatch({ type: "mcp", servers: payload.servers }));
          break;
        case "app":
          void api.bootstrap().then((payload) => dispatch({ type: "app", app: payload.app }));
          break;
        case "notice":
          dispatch({ type: "notice", text: event.textLocalized });
          break;
        default:
          break;
      }
    };
    return subscribeEvents(handle, (open) => dispatch({ type: "connected", value: open }));
  }, [refreshApprovals, refreshEmployees, refreshRooms, refreshWork]);

  const value = useMemo<ContextValue>(
    () => ({
      state,
      dispatch,
      refreshRooms,
      refreshEmployees,
      refreshWork,
      refreshApprovals,
      refreshModels,
      openRoom,
      reload,
      setError: (message) => dispatch({ type: "error", message }),
    }),
    [state, refreshRooms, refreshEmployees, refreshWork, refreshApprovals, refreshModels, openRoom, reload],
  );

  return createElement(AppContext.Provider, { value }, children);
}

export function useApp(): ContextValue {
  const value = useContext(AppContext);
  if (value === undefined) throw new Error("useApp must be used within AppProvider");
  return value;
}
