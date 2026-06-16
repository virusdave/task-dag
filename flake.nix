{
  description = "FreshlyBakedNYC/automation — reproducible Helios build toolchain (automation#50 H4)";

  # Pinned to the revision the production box (vps-nixos-3) already runs,
  # so `nix develop` reuses the on-box Nix store instead of fetching a
  # different nixpkgs. Bump deliberately; flake.lock records the exact rev.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/b51242d7d43689db2f3be91bd05d5b24fbb469c4";

  outputs = { self, nixpkgs }:
    let
      # Hosts agents and operators actually use.
      systems = [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f system);
    in {
      # `nix develop` → an identical, declarative toolchain (node + npm)
      # everywhere. This provides the TOOLCHAIN; helios/scripts/ensure-build-env.sh
      # provides the per-project prerequisites (npm install + output dirs).
      devShells = forAllSystems (system:
        let pkgs = nixpkgs.legacyPackages.${system};
        in {
          default = pkgs.mkShell {
            # nodejs_22 bundles the matching npm — pins both with one dep.
            packages = [ pkgs.nodejs_22 ];

            shellHook = ''
              echo "helios devShell — node $(node --version), npm $(npm --version)"
              echo "  build prereqs:  (cd helios && npm run ensure-build-env)"
              echo "  pre-push gate:  (cd helios && npm run check)"
            '';
          };
        });
    };
}
