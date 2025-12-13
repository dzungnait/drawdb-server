import { Request, Response } from 'express';
import { DesignService } from '../services/design-service';

// Create manual snapshot/version
async function createSnapshot(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { versionName, comment } = req.body;

    const design = await DesignService.getDesign(id);
    if (!design) {
      return res.status(404).json({
        success: false,
        message: 'Design not found',
      });
    }

    // Get current working data from snapshot
    const currentSnapshot = await DesignService.getSnapshot(id);
    if (!currentSnapshot) {
      return res.status(404).json({
        success: false,
        message: 'No current data found to create snapshot',
      });
    }

    // Create new manual version record
    const version = await DesignService.saveVersion(
      id, 
      currentSnapshot.data, 
      versionName || `Version created at ${new Date().toISOString()}`,
      comment
    );

    res.status(200).json({
      success: true,
      message: 'Version snapshot created',
      data: {
        version_number: version.version_number,
        version_name: version.version_name,
        comment: version.comment,
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

// Auto-save current design state
async function autoSave(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { data } = req.body;

    const design = await DesignService.getDesign(id);
    if (!design) {
      return res.status(404).json({
        success: false,
        message: 'Design not found',
      });
    }

    // Save/update current snapshot
    const snapshot = await DesignService.saveSnapshot(id, data);

    res.status(200).json({
      success: true,
      message: 'Auto-saved successfully',
      data: {
        last_updated: snapshot.updated_at,
      },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      success: false,
      message: 'Auto-save failed',
    });
  }
}

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

    // Save initial snapshot (current state)
    const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
    await DesignService.saveSnapshot(design.id, contentObj);

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

    const currentSnapshot = await DesignService.getSnapshot(id);
    // If no snapshot exists, return empty diagram template
    const defaultContent = JSON.stringify({
      database: 'Generic',
      tables: [],
      relationships: [],
      notes: [],
      subjectAreas: [],
      types: [],
      enums: [],
      title: design.name || 'Untitled Diagram',
      pan: { x: 0, y: 0 },
      zoom: 1,
    });
    
    const contentData = currentSnapshot?.data 
      ? (typeof currentSnapshot.data === 'string' 
          ? currentSnapshot.data 
          : JSON.stringify(currentSnapshot.data))
      : defaultContent;

    res.status(200).json({
      success: true,
      data: {
        ...design,
        files: {
          'share.json': {
            content: contentData,
            size: contentData.length,
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
    const { filename, content, createVersion } = req.body;

    const design = await DesignService.getDesign(id);
    if (!design) {
      return res.status(404).json({
        success: false,
        message: 'Design not found',
      });
    }

    const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
    
    // Update design name if title is provided in content
    if (contentObj.title && contentObj.title !== design.name) {
      await DesignService.updateDesign(id, contentObj.title);
    }
    
    // Auto-save to snapshot
    await DesignService.saveSnapshot(id, contentObj);

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

// Get all designs with pagination and search
async function listDesigns(req: Request, res: Response) {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, parseInt(req.query.limit as string) || 10);
    const search = (req.query.search as string) || '';

    const { designs, total } = await DesignService.listDesigns(page, limit, search);

    res.status(200).json({
      success: true,
      data: designs,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
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

// ====== BACKWARD COMPATIBILITY FUNCTIONS ======

// Get design (backward compatibility - gets current snapshot)
async function getDesign(req: Request, res: Response) {
  try {
    const { id: designId } = req.params;
    const version = await DesignService.getLatestVersion(designId);
    
    if (!version) {
      return res.status(404).json({ error: 'Design not found' });
    }
    
    res.json(version);
  } catch (error) {
    console.error("Get design error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

// Update design (backward compatibility - updates snapshot)
async function updateDesign(req: Request, res: Response) {
  try {
    const { id: designId } = req.params;
    const updateData = req.body;
    
    // Save as snapshot (current working state)
    const snapshot = await DesignService.saveSnapshot(designId, updateData);
    
    // Return in version format for compatibility
    const version = await DesignService.getLatestVersion(designId);
    
    res.json(version);
  } catch (error) {
    console.error("Update design error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
}

export { createOrGet, get, update, del, getCommits, getRevision, getRevisionsForFile, listDesigns, createSnapshot, autoSave, getDesign, updateDesign };
