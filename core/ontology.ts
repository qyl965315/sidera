import type { DatabaseSync } from "node:sqlite";
import { SideraError } from "./types.ts";
import { appendHistory } from "./history.ts";
import { recordWorld } from "./worlds.ts";

export type NodeKind = "Communicator" | "Operator";
export type OperatorKind = "Agent" | "Bot";
export interface NodeOntology { nodeRef:string; kind:NodeKind; operatorKind:OperatorKind|null }
export interface ChiefConversationRole {
  bindingId:string; projectRef:string; projectSpaceId:string; conversationRef:string;
  communicatorNodeRef:string; role:"ChiefConversation";
}

/** Additive ontology migration. Stable NodeRefs and exact Human bindings never change. */
export function migrateOntology(db:DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS node_ontology(
    node_ref TEXT PRIMARY KEY REFERENCES nodes(node_id),kind TEXT NOT NULL CHECK(kind IN ('Communicator','Operator')),
    operator_kind TEXT CHECK(operator_kind IN ('Agent','Bot')),
    CHECK((kind='Communicator' AND operator_kind IS NULL) OR (kind='Operator' AND operator_kind IS NOT NULL)));
    CREATE TABLE IF NOT EXISTS communicator_conversations(
      conversation_ref TEXT NOT NULL,communicator_node_ref TEXT NOT NULL REFERENCES nodes(node_id),
      frontend_kind TEXT NOT NULL,PRIMARY KEY(communicator_node_ref,conversation_ref));
    CREATE TABLE IF NOT EXISTS project_chief_roles(
      binding_id TEXT PRIMARY KEY,project_space_id TEXT NOT NULL,project_ref TEXT NOT NULL,
      communicator_node_ref TEXT NOT NULL,conversation_ref TEXT NOT NULL,state TEXT NOT NULL,
      FOREIGN KEY(communicator_node_ref,conversation_ref) REFERENCES communicator_conversations(communicator_node_ref,conversation_ref));
    CREATE UNIQUE INDEX IF NOT EXISTS one_project_chief_role ON project_chief_roles(project_space_id) WHERE state='active';
    CREATE TRIGGER IF NOT EXISTS initialize_node_ontology AFTER INSERT ON nodes BEGIN
      INSERT OR IGNORE INTO node_ontology VALUES(NEW.node_id,'Operator','Agent'); END;`);
  db.exec("INSERT OR IGNORE INTO node_ontology SELECT node_id,'Operator','Agent' FROM nodes");
  if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='chief_conversations'").get()) {
    for(const b of db.prepare("SELECT * FROM chief_conversations ORDER BY created_at,rowid").all()) syncChiefConversation(db,b);
  }
}

/** Called only by admitted Registry / Human binding mutations, never inferred from a display name. */
export function registerNodeOntology(db:DatabaseSync,nodeRef:string,input:{kind?:NodeKind;operatorKind?:OperatorKind}={}) {
  const kind=input.kind??"Operator", operatorKind=kind==="Operator"?(input.operatorKind??"Agent"):null;
  if(!["Communicator","Operator"].includes(kind)||operatorKind!==null&&!["Agent","Bot"].includes(operatorKind))
    throw new SideraError("conflict","Node ontology must be Communicator or Operator (Agent/Bot)");
  if(!db.prepare("SELECT 1 FROM nodes WHERE node_id=?").get(nodeRef))throw new SideraError("not_found","NodeRef not found");
  db.prepare("INSERT INTO node_ontology VALUES(?,?,?) ON CONFLICT(node_ref) DO UPDATE SET kind=excluded.kind,operator_kind=excluded.operator_kind")
    .run(nodeRef,kind,operatorKind);
  return readNodeOntology(db,nodeRef);
}

export function readNodeOntology(db:DatabaseSync,nodeRef:string):NodeOntology {
  const r=db.prepare("SELECT * FROM node_ontology WHERE node_ref=?").get(nodeRef);
  if(!r)throw new SideraError("not_found","Node ontology not found");
  return {nodeRef,kind:r.kind as NodeKind,operatorKind:r.operator_kind as OperatorKind|null};
}

/** Legacy chief_node_id is the owning Communicator, never a distinct Node kind. */
export function syncChiefConversation(db:DatabaseSync,b:Record<string,unknown>) {
  const owner=String(b.chief_node_id),ref=String(b.conversation_ref),bindingId=String(b.binding_id);
  registerNodeOntology(db,owner,{kind:"Communicator"});
  db.prepare("INSERT OR IGNORE INTO communicator_conversations VALUES(?,?,?)").run(ref,owner,String(b.frontend_kind));
  db.prepare(`INSERT INTO project_chief_roles VALUES(?,?,?,?,?,?) ON CONFLICT(binding_id) DO UPDATE SET state=excluded.state`)
    .run(bindingId,String(b.project_space_id),String(b.project_ref),owner,ref,String(b.state));
  appendHistory(db,{id:`ontology:chief-conversation:${bindingId}`,kind:"RoleBinding",source:"legacy-chief-binding-compatibility",
    worldRef:recordWorld(db,"nodes",owner),nodeRef:owner,communicatorRef:owner,conversationRef:ref,projectRef:String(b.project_ref),
    payload:{role:"ChiefConversation",bindingId,projectSpaceId:String(b.project_space_id),preservedBinding:true}});
}

export function chiefConversationRole(db:DatabaseSync,project:string):ChiefConversationRole|null {
  const b=db.prepare(`SELECT * FROM chief_conversations WHERE state='active' AND (project_space_id=? OR project_ref=?)`).get(project,project);
  if(!b)return null;
  return {bindingId:String(b.binding_id),projectRef:String(b.project_ref),projectSpaceId:String(b.project_space_id),
    conversationRef:String(b.conversation_ref),communicatorNodeRef:String(b.chief_node_id),role:"ChiefConversation"};
}

export type CommunicationForm="Conversation"|"Discussion"|"Thread"|"Messaging";
export function communicationForm(db:DatabaseSync,from:string|"Human",to:string):CommunicationForm {
  const target=readNodeOntology(db,to).kind;
  if(from==="Human") {
    if(target!=="Communicator")throw new SideraError("conflict","Human Conversation belongs to a Communicator");
    return "Conversation";
  }
  const source=readNodeOntology(db,from).kind;
  return source==="Communicator"&&target==="Communicator"?"Discussion":source!==target?"Thread":"Messaging";
}
