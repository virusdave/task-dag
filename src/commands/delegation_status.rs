use super::print_json;
use crate::{Result, cli::DelegateStatus, model, repository};
use serde_json::json;

pub(crate) fn status(args: DelegateStatus) -> Result<()> {
    model::bounded("operation-id", &args.operation_id, 256)?;
    if let Some(id) = args.source_repository_id.as_deref() {
        model::repository_id(id)?;
    }
    let intent_ref = model::delegation_intent_ref(&args.operation_id);
    let intent_snapshot = repository::advertise(std::slice::from_ref(&intent_ref))?;
    let intent_oid = intent_snapshot.refs.get(&intent_ref).cloned();
    let source_repository_id = match (args.source_repository_id, intent_oid.as_ref()) {
        (Some(id), Some(oid)) => {
            repository::materialize(std::slice::from_ref(oid))?;
            let intent = crate::validators::intent(oid)?;
            if intent["sourceRepositoryId"] != id {
                return Err("source-repository-id does not match local intent".into());
            }
            id
        }
        (Some(id), None) => id,
        (None, Some(oid)) => {
            repository::materialize(std::slice::from_ref(oid))?;
            crate::validators::intent(oid)?["sourceRepositoryId"]
                .as_str()
                .ok_or("validated intent lacks source repository ID")?
                .to_owned()
        }
        (None, None) => {
            return Err("source-repository-id is required when no local intent exists".into());
        }
    };
    let admission_ref = model::delegation_admission_ref(&source_repository_id, &args.operation_id);
    let export_ref = model::delegation_export_ref(&source_repository_id, &args.operation_id);
    let accepted_ref = model::delegation_accepted_ref(&source_repository_id, &args.operation_id);
    let snapshot = repository::advertise(&[
        intent_ref.clone(),
        admission_ref.clone(),
        export_ref.clone(),
        accepted_ref.clone(),
    ])?;
    print_json(&json!({
        "accepted": snapshot.refs.get(&accepted_ref),
        "admission": snapshot.refs.get(&admission_ref),
        "export": snapshot.refs.get(&export_ref),
        "intent": snapshot.refs.get(&intent_ref),
        "operationId": args.operation_id,
        "sourceRepositoryId": source_repository_id,
    }))
}
