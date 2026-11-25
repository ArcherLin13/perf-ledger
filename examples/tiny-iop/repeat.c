dt_iop_colorspace_type_t default_colorspace(dt_iop_module_t *self,
                                            dt_dev_pixelpipe_t *pipe,
                                            dt_dev_pixelpipe_iop_t *piece)
{
  return IOP_CS_RGB;
}

int process_cl(dt_iop_module_t *self, dt_dev_pixelpipe_iop_t *piece, cl_mem dev_in, cl_mem dev_out,
               const dt_iop_roi_t *const roi_in, const dt_iop_roi_t *const roi_out)
{
  for(int i = 0; i < 8; i++)
  {
    err = dt_opencl_enqueue_kernel_2d_args(devid, gd->kernel_blur, width, height,
      CLARG(dev_in), CLARG(dev_out));
  }
  return err;
}
