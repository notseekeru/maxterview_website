{
  description = "maxterview dev shell (stripe-cli + curl for the Clerk/Stripe operator tooling)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      # `nix develop .` -> a shell with the operator/CLI tooling on PATH.
      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          default = pkgs.mkShell {
            packages = with pkgs; [
              stripe-cli # Stripe sandbox CLI: `stripe login`, `stripe listen`, `stripe trigger`, ...
              curl # the clerk-stripe-operator scripts shell out to curl
              nodejs # host runtime for the @clerk/testing + Playwright headless Clerk e2e
            ];
          };
        }
      );
    };
}
