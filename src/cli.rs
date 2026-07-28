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
    Init {
        #[arg(long)]
        trusted_floor: String,
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
    Breakdown {
        task_id: String,
        #[arg(long)]
        spec: String,
        #[arg(long)]
        claim_token: String,
    },
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
    },
    Converge {
        task_id: String,
        #[arg(long)]
        operation_id: String,
    },
    Show {
        task_id: String,
    },
    Frontier,
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

pub(crate) fn run() -> Result<()> {
    match Cli::parse().command {
        Commands::Init { trusted_floor } => commands::bootstrap::init(&trusted_floor),
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
        Commands::Breakdown {
            task_id,
            spec,
            claim_token,
        } => commands::breakdown::breakdown(&task_id, &spec, &claim_token),
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
        } => commands::bootstrap::activate_runtime(&commit, &activation_lease, &operation_id),
        Commands::Converge {
            task_id,
            operation_id,
        } => commands::completion::converge(&task_id, &operation_id),
        Commands::Show { task_id } => commands::readers::show(&task_id),
        Commands::Frontier => commands::readers::frontier(),
    }
}
