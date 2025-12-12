import { Request, Response } from 'express';
import { DesignService } from '../services/design-service';

// Create a new design or get existing one by share token
async function createOrGet(req: Request, res: Response) {
  try {
    const { filename, content, public: isPublic } = req.body;

    // If filename is a share token, get existing design
    if (filename && filename.length === 21 && /^[a-zA-Z0-9_-]+$/.test(filename)) {
      const design = await DesignService.getDesignByShareToken(filename);
      if (design) {
        return res.status(200).json({
          success: true,
          data: {
            id: design.id,
            files: {
              'share.json': {
                content: content || '{}',
              },
            },
          },
        });
      }
    }

    // Create new design
    const design = await DesignService.createDesign(
      `Untitled Design ${Date.now()}`,
      'Auto-generated design',
      isPublic || false,
    );

    // Save initial version
    const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
    await DesignService.saveVersion(design.id, contentObj, 'Initial version');

    res.status(200).json({
      success: true,
      data: {
        id: design.id,
        files: {
          'share.json': {
            content: content || '{}',
          },
        },
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      message: 'Something went wrong',
    });
  }
}

// Get design by ID
async function get(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const design = await DesignService.getDesign(id);
    if (!design) {
      return res.status(404).json({
        success: false,
        message: 'Design not found',
      });
    }

    const latestVersion = await DesignService.getLatestVersion(id);

    res.status(200).json({
      success: true,
      data: {
        ...design,
        files: {
          'share.json': {
            size: latestVersion?.data ? JSON.stringify(latestVersion.data).length : 0,
            raw_url: `${req.protocol}://${req.get('host')}/designs/${id}/latest`,
            type: 'application/json',
            truncated: false,
            language: 'JSON',
          },
        },
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      message: 'Something went wrong',
    });
  }
}

// Update design with new version
async function update(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { filename, content } = req.body;

    const design = await DesignService.getDesign(id);
    if (!design) {
      return res.status(404).json({
        success: false,
        message: 'Design not found',
      });
    }

    const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
    await DesignService.saveVersion(id, contentObj, `Auto-saved at ${new Date().toISOString()}`);

    res.status(200).json({
      success: true,
      message: 'Design updated',
      data: {
        id: design.id,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      message: 'Something went wrong',
    });
  }
}

// Delete design
async function del(req: Request, res: Response) {
  try {
    const { id } = req.params;

    const design = await DesignService.getDesign(id);
    if (!design) {
      return res.status(404).json({
        success: false,
        message: 'Design not found',
      });
    }

    await DesignService.deleteDesign(id);

    res.status(200).json({
      success: true,
      message: 'Design deleted',
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      message: 'Something went wrong',
    });
  }
}

// Get version history
async function getCommits(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const page = req.query.page ? parseInt(req.query.page as string) : 1;
    const perPage = req.query.per_page ? parseInt(req.query.per_page as string) : 20;

    const design = await DesignService.getDesign(id);
    if (!design) {
      return res.status(404).json({
        success: false,
        message: 'Design not found',
      });
    }

    const offset = (page - 1) * perPage;
    const { versions, total } = await DesignService.getVersions(id, perPage, offset);

    res.status(200).json({
      success: true,
      data: versions.map((v) => ({
        version: v.version_number,
        committed_at: v.created_at,
        change_status: {
          total: 1,
          additions: 1,
          deletions: 0,
        },
        url: `${req.protocol}://${req.get('host')}/designs/${id}/versions/${v.version_number}`,
        html_url: `${req.protocol}://${req.get('host')}/designs/${id}/versions/${v.version_number}`,
        comment: v.comment || 'Auto-saved',
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      message: 'Something went wrong',
    });
  }
}

// Get specific version (SHA in gist is version number here)
async function getRevision(req: Request, res: Response) {
  try {
    const { id, sha } = req.params;
    const versionNumber = parseInt(sha, 10);

    if (isNaN(versionNumber)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid version number',
      });
    }

    const version = await DesignService.getVersion(id, versionNumber);
    if (!version) {
      return res.status(404).json({
        success: false,
        message: 'Version not found',
      });
    }

    res.status(200).json({
      success: true,
      data: {
        id: id,
        files: {
          'share.json': {
            size: JSON.stringify(version.data).length,
            raw_url: `${req.protocol}://${req.get('host')}/designs/${id}/versions/${versionNumber}`,
            type: 'application/json',
            truncated: false,
            language: 'JSON',
            content: JSON.stringify(version.data),
          },
        },
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      message: 'Something went wrong',
    });
  }
}

// Get versions for a specific file
async function getRevisionsForFile(req: Request, res: Response) {
  try {
    const { id, file } = req.params;
    const page = req.query.page ? parseInt(req.query.page as string) : 1;
    const perPage = req.query.per_page ? parseInt(req.query.per_page as string) : 20;

    const design = await DesignService.getDesign(id);
    if (!design) {
      return res.status(404).json({
        success: false,
        message: 'Design not found',
      });
    }

    const offset = (page - 1) * perPage;
    const { versions, total } = await DesignService.getVersions(id, perPage, offset);

    res.status(200).json({
      success: true,
      data: versions.map((v) => ({
        version: v.version_number,
        committed_at: v.created_at,
        change_status: {
          total: 1,
          additions: 1,
          deletions: 0,
        },
        url: `${req.protocol}://${req.get('host')}/designs/${id}/versions/${v.version_number}`,
        html_url: `${req.protocol}://${req.get('host')}/designs/${id}/versions/${v.version_number}`,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      message: 'Something went wrong',
    });
  }
}

export { createOrGet, get, update, del, getCommits, getRevision, getRevisionsForFile };
