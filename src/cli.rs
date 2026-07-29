use clap::{Args, Parser, Subcommand};

use crate::{Result, commands};

#[derive(Parser)]
#[command(name = "task-dag", about = "Minimal self-hosting task-dag v2 writer")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
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
    ActivateRuntime {
        #[arg(long)]
        commit: String,
        #[arg(long)]
        activation_lease: String,
        #[arg(long)]
        operation_id: String,
        #[arg(long, requires = "fleet_repository_id")]
        repository_id: Option<String>,
        #[arg(long, requires = "repository_id")]
        fleet_repository_id: Vec<String>,
    },
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
    Comment(Unsupported),
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
    MigrateV1 {
        #[arg(long)]
        root: String,
        #[arg(long)]
        operation_id: String,
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
enum DelegateCommands {
    Create(DelegateCreate),
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
    match Cli::parse().command {
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
        Commands::ActivateRuntime {
            commit,
            activation_lease,
            operation_id,
            repository_id,
            fleet_repository_id,
        } => commands::bootstrap::activate_runtime(
            &commit,
            &activation_lease,
            &operation_id,
            repository_id.as_deref(),
            &fleet_repository_id,
        ),
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
        Commands::Comment(_) => commands::unsupported::fail("comment"),
        Commands::Delegate {
            command: DelegateCommands::Create(args),
        } => commands::delegation::create(args),
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
        Commands::MigrateV1 { root, operation_id } => crate::migration::run(&root, &operation_id),
    }
}
