# provides-module-intellisense

## Features

Adds `@providesModule` intellisense to `import from` statements in javascript projects.

![Adding a @providesModule module](https://thumbs.gfycat.com/BelatedPertinentGoldfish-small.gif)
![Intellisense!](https://thumbs.gfycat.com/DistantIllegalCormorant-small.gif)

Will cache modules on activation, but you can manually run the module caching via the command drawer:

```
> cmd + shift + p
> Cache Modules
```

Modules are also re-cached every time they are changed.

## @todo

- ~add support for named export module predictions~ kinda works? need to figure out a way to add priority within vscode api
- add unit tests
- clean up source

## Release Notes

### 0.2.0

- Added guard against intellisense popping up when ending an import statement
- Increased max module cache

### 0.1.0

Initial release