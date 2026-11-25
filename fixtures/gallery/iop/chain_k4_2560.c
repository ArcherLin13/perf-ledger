int default_colorspace() { return IOP_CS_LAB; }
void process_cl() {
  dt_opencl_enqueue_kernel_2d(pipe, kernel, 1);
  dt_opencl_enqueue_kernel_2d(pipe, kernel, 1);
  dt_opencl_enqueue_kernel_2d(pipe, kernel, 1);
  dt_opencl_enqueue_kernel_2d(pipe, kernel, 1);
}
