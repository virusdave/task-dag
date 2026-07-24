{
  description = "Reproducible native task-dag development and build environment";

  # Match the nixpkgs revision already used on the production development host
  # so evaluation and toolchain paths can reuse its Nix store. flake.lock pins
  # this input; updating the Rust toolchain is therefore an explicit flake-input
  # and lock-file change rather than ambient host state.
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/b51242d7d43689db2f3be91bd05d5b24fbb469c4";

  outputs = { self, nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      packages = forAllSystems (system:
        let
          pkgs = pkgsFor system;
          taskDagNative = pkgs.rustPlatform.buildRustPackage {
            pname = "task-dag-native";
            version = "0.1.0";
            src = pkgs.lib.fileset.toSource {
              root = ./.;
              fileset = pkgs.lib.fileset.unions [
                ./Cargo.toml
                ./Cargo.lock
                ./src
              ];
            };
            cargoLock.lockFile = ./Cargo.lock;
            meta.mainProgram = "task-dag-native";
          };
        in
        {
          default = taskDagNative;
          task-dag-native = taskDagNative;
        });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/task-dag-native";
        };
      });

      checks = forAllSystems (system: {
        native-package = self.packages.${system}.default;
      });

      devShells = forAllSystems (system:
        let pkgs = pkgsFor system;
        in {
          default = pkgs.mkShell {
            packages = [
              pkgs.cargo
              pkgs.clippy
              pkgs.rustc
              pkgs.rustfmt
            ];
          };
        });
    };
}
