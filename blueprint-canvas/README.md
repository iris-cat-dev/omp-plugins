# Infinite Canvas

From the Desktop checkout, run `npm run build --workspace=@omp-desktop/plugin-blueprint-canvas`. In Desktop **Settings → Plugins → Add plugin → From folder**, install `plugins/blueprint-canvas` on **This Desktop**, grant the requested permissions, and enable it.

In a workspace, open **打开无限画布** from the command center. Enter a name and click **新建画布** to create `<project root>/canvases/<name>.canva.json`. A project can have several canvases; the starter graph runs without a model. To reopen a canvas, select it in the project canvas list or click its `.canva.json` file in the OMP Desktop file tree. For a separate Git worktree, the project canvas list still uses the registered project root; the file tree shows files in the selected checkout.

Use the wheel to zoom, hold Space or the middle mouse button to pan, and press **F** to fit all nodes. Drag a node by its title. Drag between pins of the same type, or select the two pins in sequence.

Nodes, connections, images, model choices, and the viewport autosave into that file on the workspace host, including for remote projects. **保存** writes immediately. If another window or editor has already changed the file, the canvas keeps its draft and reports a conflict instead of overwriting it.

Use **撤销** / **重做** or **Cmd/Ctrl+Z** / **Cmd/Ctrl+Shift+Z** while focused on the canvas. Each applied Agent proposal is one edit; zoom and pan do not create undo steps. Text fields keep their own editing shortcuts. Undo and redo are saved like other edits, while the undo history itself stays in memory.

Click **智能体生成** and describe what to add, for example: “Add an image generation node using the two pictures already on the canvas as references.” **生成预览** sends the request and a summary of the current draft, including node text and prompts but no image attachments, to the workspace host's default OMP model. Review the proposed nodes and connections, then choose **应用到画布** to accept and autosave the additions or **丢弃预览** to leave the graph unchanged. Existing nodes and connections stay in place. **运行** is a separate action; applying a proposal never calls the image provider.

Drop a PNG, JPEG, or WebP onto the canvas to create an image node. Drag the image to move it; hover or select it to reveal the bottom-right resize handle. Drop another image onto the same node to replace it without rewiring. The display size is saved with the graph; resizing leaves the image sent to the model unchanged.

Click **模型** on an **智能体** node to open a scrollable menu of OMP models from the workspace host. Use the arrow keys and Enter to choose a model, or Escape to close the menu without changing the selection. Each node saves its own selection; **主机默认** follows the host's default.

Connect image nodes to the **图片** input alongside a text prompt. The input shows the attached image count and sends them in connection order when the node runs. Choose a model under **支持图片**, or use a host default that supports images. Each image is limited to 4 MiB and 32 MP, and a canvas can store 8 MiB of image bytes. The host daemon must report model image capability.

Upgrading an existing installation requires the updated Desktop and workspace host. Rebuild the plugin, choose **Settings → Plugins → Infinite Canvas → Configure → Restart/reload**, and approve the new `workspace.files` permission. Open **打开无限画布** in each workspace with an old canvas to migrate it to a project file. Migration keeps the old data until a complete file has been written and does not overwrite named files already in the project.

To generate or edit an image, enable and configure **Settings → Host → Image generation** on the workspace host. Update the Desktop and host daemon together, then reload the plugin and grant its image-generation permission. Add **图像生成** and connect **开始 → 执行**, or connect an upstream node's completion output. Enter the prompt in the node or link a text node. Connect one or more **图片** outputs to **参考图** to edit; leave it empty to generate from text.

The result appears on the node. Connect **生成图片** and **完成** to a downstream node to use the result in the same run. To keep it between runs, click **保留为图片节点** to add it to the autosaved graph; the original reference images stay unchanged. Only running the node calls the configured image provider.

