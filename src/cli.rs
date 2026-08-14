use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

use crate::{Result, commands};

#[derive(Parser)]
#[command(name = "task-dag", about = "Minimal self-hosting task-dag v2 writer")]
struct Cli {
    /// Emit additive folded-stack operation timings to stderr.
    #[arg(long, global = true)]
    timings: bool,
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Reject hand-written task-dag control commits and non-canonical subjects.
    GuardCommitMessage {
        /// Read the proposed message from stdin instead of a file.
        #[arg(long, conflicts_with = "message_file")]
        stdin: bool,
        message_file: Option<PathBuf>,
    },
    /// Pre-push protection for native-v2 claims.
    GuardPrePush {
        remote_name: Option<String>,
        remote_url: Option<String>,
    },
    /// Authorize one ordinary origin/master publication attempt.
    AuthorizeOrdinaryPush {
        #[arg(long)]
        commit: String,
        #[arg(long)]
        operation_id: String,
        #[arg(long)]
        operator_approval: String,
        #[arg(long, requires_all = ["claim_token", "task_instruction"])]
        task_id: Option<String>,
        #[arg(long, requires_all = ["task_id", "task_instruction"])]
        claim_token: Option<String>,
        #[arg(long, requires_all = ["task_id", "claim_token"])]
        task_instruction: Option<String>,
    },
    /// Install the canonical native-v2 pre-push hook in this worktree.
    InstallHooks {
        /// Preserve an existing custom pre-push hook as pre-push.repository.
        #[arg(long)]
        migrate_existing_pre_push: bool,
    },
    Runtime {
        #[command(subcommand)]
        command: RuntimeCommands,
    },
    Init {
        #[arg(long)]
        trusted_floor: String,
        #[arg(long, requires = "fleet_repository_id")]
        repository_id: Option<String>,
        #[arg(long, requires = "repository_id")]
        fleet_repository_id: Vec<String>,
    },
    Create(Create),
    Claim {
        task_id: String,
        #[arg(long)]
        owner: String,
        #[arg(long, default_value_t = 12)]
        ttl_hours: u64,
        #[arg(long)]
        operation_id: String,
    },
    Renew {
        task_id: String,
        #[arg(long)]
        claim_token: String,
        #[arg(long, default_value_t = 12)]
        ttl_hours: u64,
        #[arg(long)]
        operation_id: String,
    },
    Release {
        task_id: String,
        #[arg(long)]
        claim_token: String,
        #[arg(long)]
        operation_id: String,
    },
    Reap {
        task_id: String,
        #[arg(long)]
        operation_id: String,
    },
    Block {
        task_id: String,
        #[arg(long)]
        claim_token: String,
        #[arg(long)]
        reason: String,
        #[arg(long)]
        authorization: String,
        #[arg(long)]
        operation_id: String,
    },
    Unblock {
        task_id: String,
        #[arg(long)]
        block_lease: String,
        #[arg(long)]
        authorization: String,
        #[arg(long)]
        operation_id: String,
    },
    Breakdown(BreakdownArgs),
    Complete {
        task_id: String,
        #[arg(long)]
        commit: String,
        #[arg(long)]
        claim_token: String,
    },
    CompleteOps(CompleteOps),
    Converge {
        task_id: String,
        #[arg(long)]
        operation_id: String,
    },
    Show {
        task_id: String,
    },
    Activation,
    Blocked,
    Deps {
        task_id: String,
    },
    Context {
        task_id: String,
    },
    Frontier,
    CurrentState {
        #[arg(long)]
        max_tasks: usize,
    },
    CurrentStatePage {
        #[arg(long, default_value = "")]
        prefix: String,
    },
    Comment {
        #[command(subcommand)]
        command: CommentCommands,
    },
    Delegate {
        #[command(subcommand)]
        command: DelegateCommands,
    },
    Dep {
        #[command(subcommand)]
        command: DepCommands,
    },
    Dag {
        task_id: String,
    },
    EpicCreate(Create),
    EpicCompose(BreakdownArgs),
    Project(Unsupported),
    Provider(Unsupported),
    MigrateV1Census {
        #[arg(long)]
        recursive_approximation: bool,
    },
    MigrateV1 {
        #[arg(long)]
        root: String,
        #[arg(long)]
        operation_id: String,
        #[arg(long, requires = "resolution_authorization")]
        terminal_external_edge: Vec<String>,
        #[arg(long, requires = "terminal_external_edge")]
        resolution_authorization: Option<String>,
        #[arg(long, requires = "terminal_external_edge")]
        resolution_evidence: Vec<String>,
        #[arg(long)]
        recursive_approximation: bool,
    },
}

#[derive(Subcommand)]
enum RuntimeCommands {
    Identity,
    Publish {
        #[arg(long)]
        commit: String,
    },
}

#[derive(Subcommand)]
enum DepCommands {
    Add(Unsupported),
    Drop(Unsupported),
}

#[derive(Subcommand)]
enum CommentCommands {
    Associate(CommentAssociate),
    ForceRequest(CommentForceRequest),
    ForceDecide(CommentForceDecide),
    ForceSend(CommentForceSend),
    Post(CommentPost),
    Reconcile(CommentReconcile),
}

#[derive(Args)]
pub(crate) struct CommentAssociate {
    pub(crate) task_id: String,
    #[arg(long)]
    pub(crate) repository: String,
    #[arg(long)]
    pub(crate) issue_number: String,
    #[arg(long)]
    pub(crate) operation_id: String,
}

#[derive(Args)]
pub(crate) struct CommentForceRequest {
    pub(crate) task_id: String,
    #[arg(long)]
    pub(crate) repository: String,
    #[arg(long)]
    pub(crate) issue_number: String,
    #[arg(long, value_parser = ["status", "operator-decision"])]
    pub(crate) kind: String,
    #[arg(long)]
    pub(crate) body_file: PathBuf,
    #[arg(long)]
    pub(crate) operation_id: String,
    #[arg(long)]
    pub(crate) amp_thread_url: String,
}

#[derive(Args)]
pub(crate) struct CommentForceDecide {
    pub(crate) request_oid: String,
    #[arg(long, value_parser = ["associate", "force"])]
    pub(crate) choice: String,
    #[arg(long)]
    pub(crate) decision_token: String,
    #[arg(long, value_parser = ["amp-thread", "one-offs-submission"])]
    pub(crate) evidence_kind: String,
    #[arg(long)]
    pub(crate) evidence: String,
    #[arg(long)]
    pub(crate) context_file: PathBuf,
    #[arg(long)]
    pub(crate) operation_id: String,
}

#[derive(Args)]
pub(crate) struct CommentForceSend {
    pub(crate) request_oid: String,
    #[arg(long)]
    pub(crate) operation_id: String,
}

#[derive(Args)]
pub(crate) struct CommentPost {
    pub(crate) task_id: String,
    #[arg(long, value_parser = ["status", "operator-decision"])]
    pub(crate) kind: String,
    #[arg(long)]
    pub(crate) body_file: PathBuf,
    #[arg(long)]
    pub(crate) operation_id: String,
}

#[derive(Args)]
pub(crate) struct CommentReconcile {
    #[arg(long)]
    pub(crate) max: usize,
    #[arg(long)]
    pub(crate) older_than: String,
}

#[derive(Subcommand)]
enum DelegateCommands {
    Create(DelegateCreate),
    Admit(DelegateAdmit),
    Export(DelegateExport),
    Accept(DelegateAccept),
    Status(DelegateStatus),
}

#[derive(Args)]
pub(crate) struct DelegateCreate {
    pub(crate) task_id: String,
    #[arg(long)]
    pub(crate) target_repository_id: String,
    #[arg(long)]
    pub(crate) operation_id: String,
    #[arg(long)]
    pub(crate) title: String,
    #[arg(long)]
    pub(crate) description: String,
    #[arg(long)]
    pub(crate) claim_token: String,
}

#[derive(Args)]
pub(crate) struct DelegateAdmit {
    #[arg(long)]
    pub(crate) source_remote: String,
    #[arg(long)]
    pub(crate) operation_id: String,
}

#[derive(Args)]
pub(crate) struct DelegateExport {
    #[arg(long)]
    pub(crate) source_repository_id: String,
    #[arg(long)]
    pub(crate) operation_id: String,
}

#[derive(Args)]
pub(crate) struct DelegateAccept {
    #[arg(long)]
    pub(crate) target_remote: String,
    #[arg(long)]
    pub(crate) operation_id: String,
}

#[derive(Args)]
pub(crate) struct DelegateStatus {
    #[arg(long)]
    pub(crate) operation_id: String,
    #[arg(long)]
    pub(crate) source_repository_id: Option<String>,
}

#[derive(Args)]
pub(crate) struct Create {
    #[arg(long)]
    pub(crate) operation_id: String,
    #[arg(long)]
    pub(crate) title: String,
    #[arg(long)]
    pub(crate) description: String,
    #[arg(long)]
    pub(crate) claim: bool,
    #[arg(long, num_args = 1..)]
    pub(crate) requires: Vec<String>,
}

#[derive(Args)]
pub(crate) struct CompleteOps {
    pub(crate) task_id: String,
    #[arg(long)]
    pub(crate) description: String,
    #[arg(long)]
    pub(crate) authorization: String,
    #[arg(long)]
    pub(crate) evidence: Vec<String>,
    #[arg(long)]
    pub(crate) claim_token: String,
}

#[derive(Args)]
struct BreakdownArgs {
    task_id: String,
    #[arg(long)]
    spec: String,
    #[arg(long)]
    claim_token: String,
}

#[derive(Args)]
struct Unsupported {
    #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
    args: Vec<String>,
}

pub(crate) fn run() -> Result<()> {
    let cli = Cli::parse();
    if cli.timings {
        crate::timing::init()?;
    }
    let _invocation = tracing::info_span!("invocation").entered();
    let command_span = cli.command.timing_span();
    let _command = command_span.entered();
    match cli.command {
        Commands::GuardCommitMessage {
            stdin,
            message_file,
        } => commands::guards::commit_message(stdin, message_file.as_deref()),
        Commands::GuardPrePush {
            remote_name,
            remote_url,
        } => commands::guards::pre_push(remote_name.as_deref(), remote_url.as_deref()),
        Commands::AuthorizeOrdinaryPush {
            commit,
            operation_id,
            operator_approval,
            task_id,
            claim_token,
            task_instruction,
        } => commands::guards::authorize_ordinary_push(
            &commit,
            &operation_id,
            &operator_approval,
            task_id.as_deref(),
            claim_token.as_deref(),
            task_instruction.as_deref(),
        ),
        Commands::InstallHooks {
            migrate_existing_pre_push,
        } => crate::repository::install_hooks(migrate_existing_pre_push),
        Commands::Runtime {
            command: RuntimeCommands::Identity,
        } => crate::runtime_authority::identity(),
        Commands::Runtime {
            command: RuntimeCommands::Publish { commit },
        } => crate::runtime_authority::publish(&commit),
        Commands::Init {
            trusted_floor,
            repository_id,
            fleet_repository_id,
        } => commands::bootstrap::init(
            &trusted_floor,
            repository_id.as_deref(),
            &fleet_repository_id,
        ),
        Commands::Create(args) => commands::bootstrap::create(args),
        Commands::Claim {
            task_id,
            owner,
            ttl_hours,
            operation_id,
        } => commands::claim::claim(&task_id, &owner, ttl_hours, &operation_id),
        Commands::Renew {
            task_id,
            claim_token,
            ttl_hours,
            operation_id,
        } => commands::claim_lifecycle::renew(&task_id, &claim_token, ttl_hours, &operation_id),
        Commands::Release {
            task_id,
            claim_token,
            operation_id,
        } => commands::claim_lifecycle::release(&task_id, Some(&claim_token), false, &operation_id),
        Commands::Reap {
            task_id,
            operation_id,
        } => commands::claim_lifecycle::release(&task_id, None, true, &operation_id),
        Commands::Block {
            task_id,
            claim_token,
            reason,
            authorization,
            operation_id,
        } => commands::blocked::block(
            &task_id,
            &claim_token,
            &reason,
            &authorization,
            &operation_id,
        ),
        Commands::Unblock {
            task_id,
            block_lease,
            authorization,
            operation_id,
        } => commands::blocked::unblock(&task_id, &block_lease, &authorization, &operation_id),
        Commands::Breakdown(args) => {
            commands::breakdown::breakdown(&args.task_id, &args.spec, &args.claim_token)
        }
        Commands::Complete {
            task_id,
            commit,
            claim_token,
        } => commands::completion::complete(&task_id, &commit, &claim_token),
        Commands::CompleteOps(args) => commands::completion::complete_ops(args),
        Commands::Converge {
            task_id,
            operation_id,
        } => commands::completion::converge(&task_id, &operation_id),
        Commands::Show { task_id } => commands::readers::show(&task_id),
        Commands::Activation => commands::readers::activation(),
        Commands::Blocked => commands::readers::blocked(),
        Commands::Deps { task_id } => commands::readers::deps(&task_id),
        Commands::Context { task_id } => commands::readers::context(&task_id),
        Commands::Frontier => commands::readers::frontier(),
        Commands::CurrentState { max_tasks } => commands::readers::current_state(max_tasks),
        Commands::CurrentStatePage { prefix } => commands::readers::current_state_page(&prefix),
        Commands::Comment {
            command: CommentCommands::Associate(args),
        } => commands::comment::associate(args),
        Commands::Comment {
            command: CommentCommands::ForceRequest(args),
        } => commands::comment::force_request(args),
        Commands::Comment {
            command: CommentCommands::ForceDecide(args),
        } => commands::comment::force_decide(args),
        Commands::Comment {
            command: CommentCommands::ForceSend(args),
        } => commands::comment::force_send(args),
        Commands::Comment {
            command: CommentCommands::Post(args),
        } => commands::comment::post(args),
        Commands::Comment {
            command: CommentCommands::Reconcile(args),
        } => commands::comment::reconcile(args),
        Commands::Delegate {
            command: DelegateCommands::Create(args),
        } => commands::delegation::create(args),
        Commands::Delegate {
            command: DelegateCommands::Admit(args),
        } => commands::delegation_admit::admit(args),
        Commands::Delegate {
            command: DelegateCommands::Export(args),
        } => commands::delegation_export::export(args),
        Commands::Delegate {
            command: DelegateCommands::Accept(args),
        } => commands::delegation_accept::accept(args),
        Commands::Delegate {
            command: DelegateCommands::Status(args),
        } => commands::delegation_status::status(args),
        Commands::Dep {
            command: DepCommands::Add(_),
        } => commands::unsupported::fail(
            "dep add; v2 requirements are immutable: declare them with create --requires or breakdown child requirements",
        ),
        Commands::Dep {
            command: DepCommands::Drop(_),
        } => commands::unsupported::fail(
            "dep drop; v2 requirements are immutable: decompose a replacement task instead",
        ),
        Commands::Dag { task_id } => commands::readers::dag(&task_id),
        Commands::EpicCreate(args) => commands::bootstrap::create(args),
        Commands::EpicCompose(args) => {
            commands::breakdown::breakdown(&args.task_id, &args.spec, &args.claim_token)
        }
        Commands::Project(_) => commands::unsupported::fail("project"),
        Commands::Provider(_) => commands::unsupported::fail("provider"),
        Commands::MigrateV1Census {
            recursive_approximation,
        } => crate::migration::census(recursive_approximation),
        Commands::MigrateV1 {
            root,
            operation_id,
            terminal_external_edge,
            resolution_authorization,
            resolution_evidence,
            recursive_approximation,
        } => crate::migration::run(
            &root,
            &operation_id,
            &terminal_external_edge,
            resolution_authorization.as_deref(),
            &resolution_evidence,
            recursive_approximation,
        ),
    }
}

impl Commands {
    fn timing_span(&self) -> tracing::Span {
        match self {
            Self::GuardCommitMessage { .. } => tracing::info_span!("command.guard-commit-message"),
            Self::GuardPrePush { .. } => tracing::info_span!("command.guard-pre-push"),
            Self::AuthorizeOrdinaryPush { .. } => {
                tracing::info_span!("command.authorize-ordinary-push")
            }
            Self::InstallHooks { .. } => tracing::info_span!("command.install-hooks"),
            Self::Runtime {
                command: RuntimeCommands::Identity,
            } => tracing::info_span!("command.runtime-identity"),
            Self::Runtime {
                command: RuntimeCommands::Publish { .. },
            } => tracing::info_span!("command.runtime-publish"),
            Self::Init { .. } => tracing::info_span!("command.init"),
            Self::Create(_) => tracing::info_span!("command.create"),
            Self::Claim { .. } => tracing::info_span!("command.claim"),
            Self::Renew { .. } => tracing::info_span!("command.renew"),
            Self::Release { .. } => tracing::info_span!("command.release"),
            Self::Reap { .. } => tracing::info_span!("command.reap"),
            Self::Block { .. } => tracing::info_span!("command.block"),
            Self::Unblock { .. } => tracing::info_span!("command.unblock"),
            Self::Breakdown(_) => tracing::info_span!("command.breakdown"),
            Self::Complete { .. } => tracing::info_span!("command.complete"),
            Self::CompleteOps(_) => tracing::info_span!("command.complete-ops"),
            Self::Converge { .. } => tracing::info_span!("command.converge"),
            Self::Show { .. } => tracing::info_span!("command.show"),
            Self::Activation => tracing::info_span!("command.activation"),
            Self::Blocked => tracing::info_span!("command.blocked"),
            Self::Deps { .. } => tracing::info_span!("command.deps"),
            Self::Context { .. } => tracing::info_span!("command.context"),
            Self::Frontier => tracing::info_span!("command.frontier"),
            Self::CurrentState { .. } => tracing::info_span!("command.current-state"),
            Self::CurrentStatePage { .. } => tracing::info_span!("command.current-state-page"),
            Self::Comment {
                command: CommentCommands::Associate(_),
            } => tracing::info_span!("command.comment-associate"),
            Self::Comment {
                command: CommentCommands::ForceRequest(_),
            } => tracing::info_span!("command.comment-force-request"),
            Self::Comment {
                command: CommentCommands::ForceDecide(_),
            } => tracing::info_span!("command.comment-force-decide"),
            Self::Comment {
                command: CommentCommands::ForceSend(_),
            } => tracing::info_span!("command.comment-force-send"),
            Self::Comment {
                command: CommentCommands::Post(_),
            } => tracing::info_span!("command.comment-post"),
            Self::Comment {
                command: CommentCommands::Reconcile(_),
            } => tracing::info_span!("command.comment-reconcile"),
            Self::Delegate {
                command: DelegateCommands::Create(_),
            } => tracing::info_span!("command.delegate-create"),
            Self::Delegate {
                command: DelegateCommands::Admit(_),
            } => tracing::info_span!("command.delegate-admit"),
            Self::Delegate {
                command: DelegateCommands::Export(_),
            } => tracing::info_span!("command.delegate-export"),
            Self::Delegate {
                command: DelegateCommands::Accept(_),
            } => tracing::info_span!("command.delegate-accept"),
            Self::Delegate {
                command: DelegateCommands::Status(_),
            } => tracing::info_span!("command.delegate-status"),
            Self::Dep {
                command: DepCommands::Add(_),
            } => tracing::info_span!("command.dep-add"),
            Self::Dep {
                command: DepCommands::Drop(_),
            } => tracing::info_span!("command.dep-drop"),
            Self::Dag { .. } => tracing::info_span!("command.dag"),
            Self::EpicCreate(_) => tracing::info_span!("command.epic-create"),
            Self::EpicCompose(_) => tracing::info_span!("command.epic-compose"),
            Self::Project(_) => tracing::info_span!("command.project"),
            Self::Provider(_) => tracing::info_span!("command.provider"),
            Self::MigrateV1Census { .. } => tracing::info_span!("command.migrate-v1-census"),
            Self::MigrateV1 { .. } => tracing::info_span!("command.migrate-v1"),
        }
    }
}
